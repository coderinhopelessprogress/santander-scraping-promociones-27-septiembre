/**
 * index.js
 * Scraper de beneficios, productos financieros y sucursales de
 * Banco Santander Argentina (www.santander.com.ar).
 *
 * Requisitos:
 *   npm install puppeteer
 *
 * Ejecución:
 *   node index.js
 *
 * Salida:
 *   ./data/promociones.json
 *   ./data/productos.json
 *   ./data/sucursales.json
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = path.join(__dirname, 'data');
const OUTPUT_FILE_PROMOCIONES = path.join(OUTPUT_DIR, 'promociones.json');
const OUTPUT_FILE_PRODUCTOS = path.join(OUTPUT_DIR, 'productos.json');
const OUTPUT_FILE_SUCURSALES = path.join(OUTPUT_DIR, 'sucursales.json');

// ============================================================
// CONFIG
// ============================================================
const CONFIG = {
  SANTANDER_URL: 'https://www.santander.com.ar/personas/beneficios#/?brandId=0740',

  // URLs de las secciones "hub" de productos financieros de Santander AR.
  // Cada una contiene varias tarjetas de producto (distintos tipos de
  // préstamo, distintos paquetes de cuenta, distintos seguros, etc.).
  CATALOGO_CATEGORIAS: [
    'https://www.santander.com.ar/personas/cuentas-y-tarjetas',
    'https://www.santander.com.ar/personas/prestamos/todos-los-prestamos',
    'https://www.santander.com.ar/personas/prendarios/prestamos-prendarios',
    'https://www.santander.com.ar/personas/inversiones',
    'https://www.santander.com.ar/personas/cuentas-y-paquetes',
    'https://www.santander.com.ar/personas/seguros',
  ],

  LIMITE_PRODUCTOS_POR_CATEGORIA: 40,

  // La sección de sucursales es una ruta hash de la misma SPA (React Router).
  SUCURSALES_URL: 'https://www.santander.com.ar/personas#/cajeros-y-sucursales',

  // false = navegador sin ventana visible, apto para correr en CI/servidor.
  // true solo para debugging manual.
  HEADLESS: true,

  // Cuando está en true, genera artefactos de diagnóstico adicionales
  // (screenshots, logs verbosos de frames/URLs) útiles para depurar
  // manualmente si el sitio cambia de estructura. En una corrida
  // desatendida conviene dejarlo en false.
  DEBUG: false,
};



// Textos genéricos / basura que NO deben quedar como "nombre" de la tarjeta,
// ni contaminar la descripción como fragmento único repetido.
const TEXTOS_BASURA = [
  'PAGANDO CON QR',
  'DE AHORRO',
  'TOPE DE REINTEGRO',
  'VER MÁS',
  'VER MAS',
  'CONOCÉ MÁS',
  'CONOCE MAS',
  'INICIO',
  'BENEFICIOS',
  'MENÚ',
  'MENU',
  'BUSCAR',
  'INGRESAR',
  'HOME BANKING',
  'SUCURSALES',
  'CONTACTO',
  'AYUDA',
  'TÉRMINOS Y CONDICIONES',
  'TERMINOS Y CONDICIONES',
  'POLÍTICA DE PRIVACIDAD',
  'POLITICA DE PRIVACIDAD',
  'SEGUINOS',
  'SÍGUENOS',
  'DERECHOS RESERVADOS',
  'TODOS LOS DERECHOS RESERVADOS',
  'CARGANDO',
  'CARGANDO...',
  'CARGANDO…',
];

function esTextoBasura(texto) {
  if (!texto) return true;
  const limpio = texto.trim().toUpperCase();
  if (limpio.length < 2) return true;
  return TEXTOS_BASURA.some((basura) => limpio === basura.toUpperCase());
}

function autoScroll(page) {
  return page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 300;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;

        if (totalHeight >= scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 200);
    });
  });
}

async function scrollHastaEstabilizar(page, maxIntentos = 15) {
  let alturaAnterior = 0;
  for (let i = 0; i < maxIntentos; i++) {
    await autoScroll(page);
    await new Promise((r) => setTimeout(r, 1200)); // esperar posible lazy-load

    const alturaActual = await page.evaluate(() => document.body.scrollHeight);
    if (alturaActual === alturaAnterior) {
      // Altura estable: probablemente ya cargó todo. Hacemos un scroll extra
      // por las dudas y salimos.
      break;
    }
    alturaAnterior = alturaActual;
  }

  // Volvemos arriba por si algún observer de scroll necesita re-disparar
  await page.evaluate(() => window.scrollTo(0, 0));
  await new Promise((r) => setTimeout(r, 500));
}

// Espera activa a que desaparezcan placeholders tipo "Cargando..." del DOM
// (muy común en SPAs que primero pintan un skeleton y after fetch reemplazan
// el texto). Hace polling en vez de una espera fija ciega.
async function esperarCargaCompleta(page, maxIntentos = 6, esperaMs = 2000) {
  for (let i = 0; i < maxIntentos; i++) {
    const tieneCargando = await page.evaluate(() =>
      document.body.innerText.toLowerCase().includes('cargando')
    );
    if (!tieneCargando) return;
    await new Promise((r) => setTimeout(r, esperaMs));
  }
}

const REGEX_DESCUENTO =
  /(\d{1,3}\s?%\s?(de\s)?(ahorro|descuento|reintegro)?)|(\d{1,2}\s?cuotas?\s?sin\s?inter[eé]s)|(tope\s?de\s?reintegro[^|]*)/i;

// PASO 1: identifica y ETIQUETA cada tarjeta candidata con data-scrap-id.
// No hace click acá: eso se maneja después, desde Puppeteer (Node.js),
// porque el click puede abrir modales/paneles fuera de la propia tarjeta.
async function etiquetarTarjetas(page) {
  return page.evaluate(() => {
    const excluirAncestros = (el) => {
      let actual = el;
      while (actual) {
        const tag = actual.tagName ? actual.tagName.toLowerCase() : '';
        if (['header', 'nav', 'footer'].includes(tag)) return true;
        const clase = (actual.className || '').toString().toLowerCase();
        const id = (actual.id || '').toString().toLowerCase();
        if (
          clase.includes('header') ||
          clase.includes('nav') ||
          clase.includes('footer') ||
          clase.includes('menu') ||
          id.includes('header') ||
          id.includes('nav') ||
          id.includes('footer') ||
          id.includes('menu')
        ) {
          return true;
        }
        actual = actual.parentElement;
      }
      return false;
    };

    const selectoresCandidatos = [
      '[class*="card" i]',
      '[class*="beneficio" i]',
      '[class*="promo" i]',
      'article',
      'li',
    ];

    const candidatosSet = new Set();
    selectoresCandidatos.forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => candidatosSet.add(el));
    });

    let candidatos = Array.from(candidatosSet).filter((el) => {
      if (excluirAncestros(el)) return false;
      const tieneImg = !!el.querySelector('img');
      const texto = (el.textContent || '').trim();
      return tieneImg && texto.length > 3;
    });

    // Solo el nodo más externo de cada cadena anidada (evita duplicados)
    candidatos = candidatos.filter((el) => {
      return !candidatos.some((otro) => otro !== el && otro.contains(el));
    });

    candidatos.forEach((card, i) => {
      card.setAttribute('data-scrap-id', String(i));
    });

    return candidatos.length;
  });
}

// Extrae, dentro del navegador, la info "en reposo" (sin click) de una tarjeta.
async function extraerInfoBaseTarjeta(page, scrapId) {
  return page.evaluate((id) => {
    const card = document.querySelector(`[data-scrap-id="${id}"]`);
    if (!card) return null;

    const img = card.querySelector('img');
    const imagen = img
      ? img.currentSrc || img.src || img.getAttribute('data-src') || null
      : null;

    const linkEl =
      card.tagName.toLowerCase() === 'a' ? card : card.querySelector('a[href]');
    const enlace = linkEl ? linkEl.href : null;

    const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT, null);
    const nodosTexto = [];
    let nodo;
    while ((nodo = walker.nextNode())) {
      const t = nodo.textContent.replace(/\s+/g, ' ').trim();
      if (t) nodosTexto.push(t);
    }
    const textos = [...new Set(nodosTexto)];

    return { imagen, enlace, textos };
  }, scrapId);
}

// Tras el click, busca texto de descuento/detalle: primero dentro de la
// propia tarjeta (por si expandió inline) y, si no, en modales/paneles
// nuevos agregados al body.
async function extraerTextoExpandido(page, scrapId) {
  return page.evaluate((id) => {
    const card = document.querySelector(`[data-scrap-id="${id}"]`);
    const textosCard = [];
    if (card) {
      const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT, null);
      let nodo;
      while ((nodo = walker.nextNode())) {
        const t = nodo.textContent.replace(/\s+/g, ' ').trim();
        if (t) textosCard.push(t);
      }
    }

    // Contenedores típicos de modal/panel/tooltip que suelen inyectarse
    // fuera de la tarjeta original al hacer click.
    const selectoresModal = [
      '[class*="modal" i]',
      '[class*="dialog" i]',
      '[class*="popup" i]',
      '[class*="overlay" i]',
      '[class*="panel" i]',
      '[class*="detalle" i]',
      '[class*="tooltip" i]',
      '[role="dialog"]',
    ];

    let textosModal = [];
    let elementoModal = null;
    for (const sel of selectoresModal) {
      const candidatos = Array.from(document.querySelectorAll(sel)).filter((el) => {
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden';
      });
      if (candidatos.length > 0) {
        // Tomamos el más grande en texto (probablemente el modal real)
        elementoModal = candidatos.sort(
          (a, b) => b.textContent.length - a.textContent.length
        )[0];
        break;
      }
    }

    if (elementoModal) {
      const walker = document.createTreeWalker(elementoModal, NodeFilter.SHOW_TEXT, null);
      let nodo;
      while ((nodo = walker.nextNode())) {
        const t = nodo.textContent.replace(/\s+/g, ' ').trim();
        if (t) textosModal.push(t);
      }
    }

    return {
      textosCard: [...new Set(textosCard)],
      textosModal: [...new Set(textosModal)],
      huboModal: !!elementoModal,
    };
  }, scrapId);
}

async function cerrarModalSiExiste(page) {
  // Intento 1: botón de cierre visible
  const cerrado = await page.evaluate(() => {
    const selectoresCerrar = [
      '[class*="close" i]',
      '[aria-label*="cerrar" i]',
      '[aria-label*="close" i]',
      'button[class*="cerrar" i]',
    ];
    for (const sel of selectoresCerrar) {
      const btn = document.querySelector(sel);
      if (btn) {
        btn.click();
        return true;
      }
    }
    return false;
  });

  if (!cerrado) {
    // Intento 2: tecla Escape (patrón común en modales accesibles)
    await page.keyboard.press('Escape').catch(() => {});
  }

  await new Promise((r) => setTimeout(r, 400));
}

// PASO 2: recorre cada tarjeta etiquetada, hace click real con Puppeteer,
// espera el render y extrae el detalle expandido (descuento, tope, días).
async function procesarTarjetasConClick(page, cantidad) {
  const resultados = [];

  for (let i = 0; i < cantidad; i++) {
    const selector = `[data-scrap-id="${i}"]`;
    const info = await extraerInfoBaseTarjeta(page, i);
    if (!info) continue;

    let textosFinal = info.textos;
    let huboClickExitoso = false;

    try {
      const handle = await page.$(selector);
      if (handle) {
        await handle.scrollIntoView().catch(() => {});
        await new Promise((r) => setTimeout(r, 150));
        await handle.click({ delay: 50 });
        huboClickExitoso = true;
        await handle.dispose();
      }
    } catch (err) {
      // Si el click falla (elemento tapado, no clickeable, etc.) seguimos
      // solo con el texto "en reposo" de la tarjeta.
      huboClickExitoso = false;
    }

    if (huboClickExitoso) {
      // Espera a que el detalle/modal renderice
      await new Promise((r) => setTimeout(r, 900));
      // Y a que cualquier "Cargando..." dentro del detalle se resuelva
      await esperarCargaCompleta(page, 4, 1500);

      const expandido = await extraerTextoExpandido(page, i);
      if (expandido) {
        if (expandido.huboModal && expandido.textosModal.length > 0) {
          textosFinal = [...new Set([...info.textos, ...expandido.textosModal])];
        } else if (expandido.textosCard.length > info.textos.length) {
          textosFinal = expandido.textosCard;
        }
      }

      await cerrarModalSiExiste(page);
    }

    resultados.push({
      __imagen: info.imagen,
      __enlace: info.enlace,
      __textos: textosFinal,
    });
  }

  return resultados;
}

function procesarTarjetasCrudas(tarjetasCrudas, urlBase) {
  const vistos = new Set();
  const productos = [];

  for (const cruda of tarjetasCrudas) {
    const textos = (cruda.__textos || []).filter((t) => !esTextoBasura(t));
    if (textos.length === 0) continue;

    // El "nombre" es el primer texto útil no genérico (usualmente el título de la promo)
    const nombre = textos[0];
    if (!nombre) continue;

    // Buscamos un texto que parezca porcentaje/ahorro/cuotas para precio_descuento.
    // Si tras el click no se encontró texto de descuento, el campo queda en null.
    let precioDescuento = null;
    for (const t of textos) {
      const match = t.match(REGEX_DESCUENTO);
      if (match) {
        precioDescuento = match[0].trim();
        break;
      }
    }

    const imagen = cruda.__imagen
      ? new URL(cruda.__imagen, urlBase).href
      : null;

    const enlace = cruda.__enlace
      ? new URL(cruda.__enlace, urlBase).href
      : null;

    const descripcion = textos.join(' | ');

    // Clave de deduplicación: nombre + imagen (o enlace si no hay imagen)
    const claveDedup = `${nombre}::${imagen || enlace || ''}`;
    if (vistos.has(claveDedup)) continue;
    vistos.add(claveDedup);

    productos.push({
      nombre,
      precio: null,
      precio_descuento: precioDescuento,
      imagen,
      código: enlace || null,
      descripción: descripcion,
      condiciones: 'Revisar TyC en la web de Santander.',
      url_producto: enlace || null,
    });
  }

  return productos;
}

// ============================================================
// MÓDULO 1: PROMOCIONES / BENEFICIOS BANCARIOS (Santander)
// ============================================================

// Busca, entre las claves de un objeto, la primera que matchee alguno de
// los nombres candidatos (case-insensitive). Sirve para leer campos de la
// API real sin asumir el nombre exacto de la propiedad.
function leerCampo(obj, nombresCandidatos) {
  if (!obj || typeof obj !== 'object') return null;
  const claves = Object.keys(obj);
  for (const candidato of nombresCandidatos) {
    const clave = claves.find((k) => k.toLowerCase() === candidato.toLowerCase());
    if (clave && obj[clave] !== undefined && obj[clave] !== null && obj[clave] !== '') {
      return obj[clave];
    }
  }
  return null;
}

// Determina si un array "parece" un listado de beneficios: la mayoría de
// sus elementos son objetos que traen al menos dos campos típicos de una
// promoción (marca, descuento, vigencia, etc.), sin asumir un esquema fijo.
function pareceListaDeBeneficios(array) {
  if (!Array.isArray(array) || array.length === 0) return false;
  const CAMPOS_TIPICOS = [
    'marca', 'nombre', 'name', 'brand', 'comercio',
    'descuento', 'discount', 'porcentaje', 'ahorro', 'reintegro',
    'tope', 'vigencia', 'fechafin', 'diassemana', 'dias',
    'logo', 'imagen', 'image', 'url', 'link',
  ];
  let coincidencias = 0;
  const muestra = array.slice(0, Math.min(5, array.length));
  muestra.forEach((item) => {
    if (!item || typeof item !== 'object') return;
    const claves = Object.keys(item).map((k) => k.toLowerCase());
    const matches = CAMPOS_TIPICOS.filter((c) => claves.includes(c)).length;
    if (matches >= 2) coincidencias++;
  });
  return coincidencias >= Math.ceil(muestra.length / 2);
}

// Recorre recursivamente un JSON arbitrario (objeto o array) buscando el
// primer array interno que parezca un listado de beneficios.
function buscarArrayDeBeneficios(nodo, profundidad = 0) {
  if (profundidad > 6 || nodo === null || typeof nodo !== 'object') return null;

  if (Array.isArray(nodo)) {
    if (pareceListaDeBeneficios(nodo)) return nodo;
    for (const item of nodo) {
      const encontrado = buscarArrayDeBeneficios(item, profundidad + 1);
      if (encontrado) return encontrado;
    }
    return null;
  }

  for (const valor of Object.values(nodo)) {
    const encontrado = buscarArrayDeBeneficios(valor, profundidad + 1);
    if (encontrado) return encontrado;
  }
  return null;
}

// Mapea un ítem crudo de la API al esquema de salida del proyecto.
function mapearBeneficioDesdeApi(item, urlBase) {
  const nombre = leerCampo(item, ['marca', 'nombre', 'name', 'brand', 'comercio']);
  if (!nombre) return null;

  const porcentaje = leerCampo(item, ['descuento', 'discount', 'porcentaje', 'ahorro']);
  const tope = leerCampo(item, ['tope', 'topereintegro', 'topemaximo']);
  const vigencia = leerCampo(item, ['vigencia', 'fechafin', 'fechavigencia']);
  const dias = leerCampo(item, ['dias', 'diassemana', 'diasvalidos']);

  const partesDescripcion = [porcentaje, tope, vigencia, dias]
    .filter((v) => v !== null && v !== undefined && v !== '')
    .map(String);

  const imagenRaw = leerCampo(item, ['logo', 'imagen', 'image', 'urlimagen', 'logourl']);
  const imagen = imagenRaw ? new URL(String(imagenRaw), urlBase).href : null;

  const enlaceRaw = leerCampo(item, ['url', 'link', 'urldetalle', 'enlace']);
  const enlace = enlaceRaw ? new URL(String(enlaceRaw), urlBase).href : null;

  return {
    nombre: String(nombre).trim(),
    precio: null,
    precio_descuento: porcentaje !== null && porcentaje !== undefined ? String(porcentaje) : null,
    imagen,
    código: enlace || null,
    descripción: partesDescripcion.join(' | ') || String(nombre).trim(),
    condiciones: 'Revisar TyC en la web de Santander.',
    url_producto: enlace || null,
  };
}

// Adjunta un listener de red que va acumulando toda respuesta JSON recibida
// mientras la página carga. La SPA de beneficios consulta una API interna
// que devuelve el listado ya estructurado (marca, descuento, tope, vigencia);
// interceptarla evita tener que simular clicks y parsear el DOM renderizado.
function registrarCapturaDeRespuestasJson(page) {
  const respuestas = [];
  page.on('response', async (response) => {
    try {
      const contentType = response.headers()['content-type'] || '';
      if (!contentType.includes('json')) return;
      const cuerpo = await response.json();
      respuestas.push({ url: response.url(), cuerpo });
    } catch (err) {
      // Respuesta no parseable como JSON (ya consumida, vacía, etc.): se ignora.
    }
  });
  return respuestas;
}

async function scrapearPromociones(browser) {
  console.log('\n=== [1/3] Scrapeando promociones (Santander) ===');
  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
  );

  const respuestasJson = registrarCapturaDeRespuestasJson(page);

  try {
    console.log(`Navegando a: ${CONFIG.SANTANDER_URL}`);
    await page.goto(CONFIG.SANTANDER_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    console.log('Esperando carga inicial de la SPA...');
    await new Promise((r) => setTimeout(r, 6000));

    console.log('Realizando scroll progresivo para activar lazy-loading...');
    await scrollHastaEstabilizar(page);
    await new Promise((r) => setTimeout(r, 3000));

    if (CONFIG.DEBUG) {
      console.log(`  Respuestas JSON capturadas: ${respuestasJson.length}`);
      respuestasJson.forEach((r) => console.log(`    - ${r.url}`));
    }

    // Estrategia principal: buscar el listado de beneficios entre las
    // respuestas JSON reales que consultó la SPA.
    let arrayBeneficios = null;
    for (const respuesta of respuestasJson) {
      arrayBeneficios = buscarArrayDeBeneficios(respuesta.cuerpo);
      if (arrayBeneficios) {
        console.log(`  Listado de beneficios encontrado en API: ${respuesta.url}`);
        break;
      }
    }

    if (arrayBeneficios) {
      const promociones = arrayBeneficios
        .map((item) => mapearBeneficioDesdeApi(item, CONFIG.SANTANDER_URL))
        .filter(Boolean);
      console.log(`Promociones obtenidas desde la API: ${promociones.length}`);
      return promociones;
    }

    // Estrategia de respaldo: si no se pudo identificar la respuesta de la
    // API (endpoint distinto, respuesta no-JSON, cambio de arquitectura),
    // se recurre a la extracción por DOM con interacción de click.
    console.log('  No se identificó la API de beneficios, aplicando extracción por DOM como respaldo...');

    const cantidadTarjetas = await etiquetarTarjetas(page);
    console.log(`Tarjetas candidatas encontradas: ${cantidadTarjetas}`);

    const tarjetasCrudas = await procesarTarjetasConClick(page, cantidadTarjetas);
    const promociones = procesarTarjetasCrudas(tarjetasCrudas, CONFIG.SANTANDER_URL);
    console.log(`Promociones obtenidas por DOM (respaldo): ${promociones.length}`);
    return promociones;
  } catch (err) {
    console.error('Error scrapeando promociones:', err.message);
    return [];
  } finally {
    await page.close();
  }
}

// ============================================================
// MÓDULO 2: CATÁLOGO DE PRODUCTOS
// ============================================================

// Intenta leer datos estructurados schema.org/Product (JSON-LD).
// Se mantiene como intento #1 por si alguna landing lo trae, pero en un
// sitio de banco como Santander AR es poco probable que exista: las
// "landings" de producto no son fichas de e-commerce.
function extraerProductoDesdeJsonLd() {
  const scripts = Array.from(
    document.querySelectorAll('script[type="application/ld+json"]')
  );

  for (const script of scripts) {
    let data;
    try {
      data = JSON.parse(script.textContent);
    } catch (e) {
      continue;
    }

    const candidatos = Array.isArray(data) ? data : [data];
    for (const item of candidatos) {
      const tipo = item['@type'];
      const esProducto =
        tipo === 'Product' || (Array.isArray(tipo) && tipo.includes('Product'));
      if (!esProducto) continue;

      const oferta = Array.isArray(item.offers) ? item.offers[0] : item.offers;

      return {
        nombre: item.name || null,
        precio: oferta && oferta.price ? Number(oferta.price) : null,
        imagen: Array.isArray(item.image) ? item.image[0] : item.image || null,
        codigo: item.sku || item.gtin13 || item.gtin || item.mpn || null,
        descripcion: item.description || null,
      };
    }
  }
  return null;
}

// Regex para "precio" (en productos bancarios, la tasa cumple ese rol,
// ya que no hay precio de góndola) y para promos/bonificaciones que
// funcionan como "precio_descuento".
const REGEX_TASA = /tasa\s+fija\s+nominal\s+anual:?\s*([\d.,]+\s?%)/i;
const REGEX_BONIFICACION =
  /(bonificaci[oó]n\s+del\s+[\d.,]+\s?%[^.]*|[\d.,]+\s?%\s+de\s+descuento[^.]*)/i;

// Frases típicas de letra chica / condiciones que vimos en las páginas
// reales de Santander (tasas, comisiones, sujeto a aprobación, etc.)
const REGEX_CONDICIONES =
  /(sujeto a aprobaci[oó]n crediticia[^.]*\.)|(tasa fija nominal anual[^.]*\.)|(comisi[oó]n por cancelaci[oó]n anticipada[^.]*\.)|(sistema de amortizaci[oó]n franc[eé]s[^.]*\.)/gi;

// Heurística de respaldo por DOM: pensada para landings tipo hub de
// productos bancarios (cards con título + bajada + CTA "Conocé más"/
// "Simulá tu préstamo"/"Pedilo ahora", y un bloque de legales al pie).
function extraerProductoDesdeDom() {
  // IMPORTANTE: estas regex se declaran ACÁ ADENTRO (y no afuera, en scope
  // de Node) porque page.evaluate() solo serializa el CUERPO de la función
  // hacia el navegador — las variables externas (closures) no viajan y
  // quedan "undefined" del lado del browser. Por eso rompía con
  // "REGEX_TASA is not defined".
  const REGEX_TASA_LOCAL = /tasa\s+fija\s+nominal\s+anual:?\s*([\d.,]+\s?%)/i;
  const REGEX_BONIFICACION_LOCAL =
    /(bonificaci[oó]n\s+del\s+[\d.,]+\s?%[^.]*|[\d.,]+\s?%\s+de\s+descuento[^.]*)/i;
  const REGEX_CONDICIONES_LOCAL =
    /(sujeto a aprobaci[oó]n crediticia[^.]*\.)|(tasa fija nominal anual[^.]*\.)|(comisi[oó]n por cancelaci[oó]n anticipada[^.]*\.)|(sistema de amortizaci[oó]n franc[eé]s[^.]*\.)/gi;

  const nombreEl = document.querySelector(
    'h1, [class*="product-name" i], [class*="titulo" i] h1, [class*="titulo" i] h2'
  );
  const nombre = nombreEl ? nombreEl.textContent.trim() : null;

  const imgEl = document.querySelector(
    'main img, [class*="hero" i] img, [class*="banner" i] img'
  );
  const imagen = imgEl
    ? imgEl.currentSrc || imgEl.src || imgEl.getAttribute('data-src')
    : null;

  const bodyTexto = document.body.innerText || '';

  const matchTasa = bodyTexto.match(REGEX_TASA_LOCAL);
  const precio = matchTasa ? matchTasa[1].trim() : null; // ej: "79,00 %" (TNA)

  const matchBonif = bodyTexto.match(REGEX_BONIFICACION_LOCAL);
  const precioDescuento = matchBonif ? matchBonif[0].trim() : null;

  const descEl = document.querySelector(
    'main p, [class*="description" i], [class*="bajada" i], [class*="subtitulo" i]'
  );
  const descripcion = descEl ? descEl.textContent.replace(/\s+/g, ' ').trim() : null;

  const matchesCondiciones = [...bodyTexto.matchAll(REGEX_CONDICIONES_LOCAL)]
    .map((m) => m[0].trim())
    .slice(0, 5); // hasta 5 frases de letra chica, para no traer el legal completo
  const condiciones =
    matchesCondiciones.length > 0 ? matchesCondiciones.join(' | ') : null;

  return {
    nombre,
    precio,
    precio_descuento: precioDescuento,
    imagen,
    codigo: null,
    descripcion,
    condiciones,
  };
}

// Recolecta los links a "producto" (landing individual) dentro de una
// página hub (ej: /personas/prestamos/todos-los-prestamos), que en
// Santander son tarjetas con CTA tipo "Conocé más" / "Simulá tu préstamo".
async function obtenerLinksDeProductos(page) {
  await scrollHastaEstabilizar(page);

  return page.evaluate(() => {
    const excluirAncestros = (el) => {
      let actual = el;
      while (actual) {
        const tag = actual.tagName ? actual.tagName.toLowerCase() : '';
        if (['header', 'nav', 'footer'].includes(tag)) return true;
        actual = actual.parentElement;
      }
      return false;
    };

    // Los CTA de tarjetas de producto en Santander suelen ser <a> con
    // texto corto tipo "Conocé más", "Simulá", "Pedilo ahora", o links
    // dentro de contenedores con clase "card"/"tarjeta"/"producto".
    const textosCTA = [
      'conoce mas', 'conocé más', 'conoce más', 'simula', 'simulá',
      'pedilo', 'solicitalo', 'solicitá', 'ver más', 'ver mas',
    ];

    const selectoresContenedor = [
      '[class*="card" i] a[href]',
      '[class*="tarjeta" i] a[href]',
      '[class*="producto" i] a[href]',
    ];

    const links = new Set();

    document.querySelectorAll(selectoresContenedor.join(',')).forEach((a) => {
      if (excluirAncestros(a)) return;
      if (a.href && a.href.includes('santander.com.ar')) links.add(a.href);
    });

    // Fallback: cualquier <a> cuyo texto matchee un CTA típico
    document.querySelectorAll('a[href]').forEach((a) => {
      if (excluirAncestros(a)) return;
      const texto = (a.textContent || '').trim().toLowerCase();
      if (textosCTA.some((cta) => texto.includes(cta))) {
        if (a.href && a.href.includes('santander.com.ar')) links.add(a.href);
      }
    });

    return Array.from(links);
  });
}

// Extrae tarjetas informativas directamente desde la página hub, sin
// depender de que tengan un link de detalle propio (muchas landings de
// Santander muestran la oferta financiera completa en la misma card).
// Selectores pedidos explícitamente: article, [class*="card"], 
// div[class*="product"], y headings h2/h3 como fallback final.
function extraerTarjetasInformativasDesdeHub() {
  const excluirAncestros = (el) => {
    let actual = el;
    while (actual) {
      const tag = actual.tagName ? actual.tagName.toLowerCase() : '';
      if (['header', 'nav', 'footer'].includes(tag)) return true;
      actual = actual.parentElement;
    }
    return false;
  };

  const selectoresCandidatos = [
    'article',
    '[class*="card" i]',
    'div[class*="product" i]',
  ];

  const candidatosSet = new Set();
  selectoresCandidatos.forEach((sel) => {
    document.querySelectorAll(sel).forEach((el) => candidatosSet.add(el));
  });

  let candidatos = Array.from(candidatosSet).filter((el) => {
    if (excluirAncestros(el)) return false;
    const texto = (el.textContent || '').trim();
    return texto.length > 15;
  });

  // Solo el nodo más externo de cada cadena anidada (evita duplicados)
  candidatos = candidatos.filter(
    (el) => !candidatos.some((otro) => otro !== el && otro.contains(el))
  );

  // Fallback final: si no hubo candidatos por clase/tag, agrupamos por
  // headings h2/h3 (título del producto) + su párrafo/contenedor padre.
  if (candidatos.length === 0) {
    document.querySelectorAll('h2, h3').forEach((heading) => {
      if (excluirAncestros(heading)) return;
      const contenedor = heading.closest('section, div') || heading.parentElement;
      if (contenedor && !candidatosSet.has(contenedor)) {
        candidatos.push(contenedor);
        candidatosSet.add(contenedor);
      }
    });
  }

  return candidatos.map((card) => {
    const heading = card.querySelector('h1, h2, h3, h4');
    const nombre = heading ? heading.textContent.replace(/\s+/g, ' ').trim() : null;

    const img = card.querySelector('img');
    const imagen = img
      ? img.currentSrc || img.src || img.getAttribute('data-src') || null
      : null;

    const linkEl = card.tagName.toLowerCase() === 'a' ? card : card.querySelector('a[href]');
    const enlace = linkEl ? linkEl.href : null;

    const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT, null);
    const textos = [];
    let nodo;
    while ((nodo = walker.nextNode())) {
      const t = nodo.textContent.replace(/\s+/g, ' ').trim();
      if (t) textos.push(t);
    }
    const textosUnicos = [...new Set(textos)];
    const bodyCardTexto = textosUnicos.join(' ');

    return { nombre, imagen, enlace, textos: textosUnicos, textoCompleto: bodyCardTexto };
  });
}

async function scrapearDetalleProducto(page, url) {
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise((r) => setTimeout(r, 1500));

    const jsonLd = await page.evaluate(extraerProductoDesdeJsonLd);
    const dom = await page.evaluate(extraerProductoDesdeDom);

    const nombre = (jsonLd && jsonLd.nombre) || dom.nombre;
    if (!nombre) return null; // sin nombre no es un producto válido

    const imagenRaw = (jsonLd && jsonLd.imagen) || dom.imagen;
    const imagen = imagenRaw ? new URL(imagenRaw, url).href : null;

    return {
      nombre,
      precio: (jsonLd && jsonLd.precio) ?? dom.precio ?? null, // TNA/tasa en productos bancarios
      precio_descuento: dom.precio_descuento ?? null,
      imagen,
      código: (jsonLd && jsonLd.codigo) || dom.codigo || url, // Santander no expone SKU: cae a la URL
      descripción: (jsonLd && jsonLd.descripcion) || dom.descripcion || null,
      condiciones: dom.condiciones || 'Revisar TyC en la web de Santander.',
      url_producto: url,
    };
  } catch (err) {
    console.error(`  ! Error en detalle de producto (${url}):`, err.message);
    return null;
  }
}

async function scrapearProductos(browser) {
  console.log('\n=== [2/3] Scrapeando catálogo de productos ===');
  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
  );

  const productos = [];
  const urlsVistas = new Set();

  try {
    for (const categoriaUrl of CONFIG.CATALOGO_CATEGORIAS) {
      console.log(`Categoría: ${categoriaUrl}`);
      try {
        await page.goto(categoriaUrl, { waitUntil: 'networkidle2', timeout: 60000 });

        // Espera explícita a que aparezca ALGÚN contenedor de contenido
        // (article, card, product o al menos un h2/h3) antes de seguir.
        await page
          .waitForSelector('article, [class*="card" i], div[class*="product" i], h2, h3', {
            timeout: 15000,
          })
          .catch(() => {
            console.log('  (timeout esperando selector genérico, sigo igual)');
          });

        await new Promise((r) => setTimeout(r, 3000));
        await esperarCargaCompleta(page);
      } catch (err) {
        console.error(`  ! No se pudo cargar la categoría: ${err.message}`);
        continue;
      }

      let links = await obtenerLinksDeProductos(page);
      links = links.filter((l) => !urlsVistas.has(l));

      if (CONFIG.LIMITE_PRODUCTOS_POR_CATEGORIA) {
        links = links.slice(0, CONFIG.LIMITE_PRODUCTOS_POR_CATEGORIA);
      }

      console.log(`  Links de producto encontrados: ${links.length}`);

      if (links.length > 0) {
        for (const link of links) {
          if (urlsVistas.has(link)) continue;
          urlsVistas.add(link);

          const producto = await scrapearDetalleProducto(page, link);
          if (producto) {
            productos.push(producto);
            console.log(`  + ${producto.nombre}`);
          }
        }
      } else {
        // FALLBACK: no encontramos links de detalle -> extraemos las
        // tarjetas/ofertas directamente desde la página hub actual.
        console.log('  Sin links de detalle: extrayendo tarjetas directamente del hub...');
        const tarjetas = await page.evaluate(extraerTarjetasInformativasDesdeHub);

        tarjetas.forEach((t) => {
          const textosLimpios = t.textos.filter((x) => !esTextoBasura(x));
          const nombre = t.nombre || textosLimpios[0] || null;
          if (!nombre) return;

          const matchTasa = t.textoCompleto.match(REGEX_TASA);
          const matchBonif = t.textoCompleto.match(REGEX_BONIFICACION);
          const matchesCondiciones = [...t.textoCompleto.matchAll(REGEX_CONDICIONES)]
            .map((m) => m[0].trim())
            .slice(0, 5);

          const imagen = t.imagen ? new URL(t.imagen, categoriaUrl).href : null;
          const enlace = t.enlace ? new URL(t.enlace, categoriaUrl).href : null;
          const claveDedup = `${nombre}::${imagen || enlace || categoriaUrl}`;

          if (urlsVistas.has(claveDedup)) return;
          urlsVistas.add(claveDedup);

          productos.push({
            nombre,
            precio: matchTasa ? matchTasa[1].trim() : null,
            precio_descuento: matchBonif ? matchBonif[0].trim() : null,
            imagen,
            código: enlace || categoriaUrl,
            descripción: textosLimpios.join(' | '),
            condiciones:
              matchesCondiciones.length > 0
                ? matchesCondiciones.join(' | ')
                : 'Revisar TyC en la web de Santander.',
            url_producto: enlace || categoriaUrl,
          });
          console.log(`  + ${nombre}`);
        });
      }
    }

    console.log(`Productos únicos procesados: ${productos.length}`);
    return productos;
  } catch (err) {
    console.error('Error scrapeando productos:', err.message);
    return productos;
  } finally {
    await page.close();
  }
}

// ============================================================
// MÓDULO 3: SUCURSALES
// ============================================================

// Busca datos estructurados de sucursal (LocalBusiness / GroceryStore /
// ItemList de Place) vía JSON-LD, que muchos store-locators exponen.
function extraerSucursalesDesdeJsonLd() {
  const scripts = Array.from(
    document.querySelectorAll('script[type="application/ld+json"]')
  );
  const resultados = [];

  const mapearItem = (item) => {
    const direccion = item.address
      ? [
          item.address.streetAddress,
          item.address.addressLocality,
          item.address.addressRegion,
        ]
          .filter(Boolean)
          .join(', ')
      : null;

    const horarios = Array.isArray(item.openingHours)
      ? item.openingHours.join(' | ')
      : item.openingHours || null;

    return {
      nombre: item.name || null,
      direccion,
      horarios,
      telefono: item.telephone || null,
      coordenadas:
        item.geo && item.geo.latitude && item.geo.longitude
          ? { lat: Number(item.geo.latitude), lng: Number(item.geo.longitude) }
          : null,
    };
  };

  for (const script of scripts) {
    let data;
    try {
      data = JSON.parse(script.textContent);
    } catch (e) {
      continue;
    }

    const candidatos = Array.isArray(data) ? data : [data];
    for (const item of candidatos) {
      const tipo = item['@type'];
      if (
        tipo === 'LocalBusiness' ||
        tipo === 'GroceryStore' ||
        tipo === 'Store' ||
        (Array.isArray(tipo) &&
          (tipo.includes('LocalBusiness') || tipo.includes('GroceryStore')))
      ) {
        resultados.push(mapearItem(item));
      }
      if (item['@type'] === 'ItemList' && Array.isArray(item.itemListElement)) {
        item.itemListElement.forEach((el) => {
          const entidad = el.item || el;
          if (entidad && entidad.address) resultados.push(mapearItem(entidad));
        });
      }
    }
  }

  return resultados;
}

// La ficha de cada sucursal en el listado de resultados se estructura como
// un <p> con el patrón "NÚMERO / <span>Nombre de la sucursal</span>"
// (ej: "169 / Sucursal Congreso"). No se usan selectores por clase CSS
// porque el sitio usa styled-components, que regenera las clases hasheadas
// en cada deploy; la estructura del markup es más estable que esos nombres.
function extraerSucursalesDesdeEstructura() {
  const resultados = [];

  // Frases que delatan que el texto capturado pertenece al widget del
  // mapa/buscador en lugar de a la dirección real de la sucursal.
  const BLACKLIST_TEXTO =
    /filtrar sucursales|buscar sucursal|google maps|mapa de google|cargando/i;

  const esTextoUtil = (texto) =>
    !!texto && texto.length > 2 && !BLACKLIST_TEXTO.test(texto);

  const parrafos = Array.from(document.querySelectorAll('p')).filter((p) =>
    p.querySelector('span')
  );

  parrafos.forEach((p) => {
    const span = p.querySelector('span');
    const pTexto = (p.textContent || '').replace(/\s+/g, ' ').trim();

    // Patrón esperado: "169 / Sucursal Congreso"
    const match = pTexto.match(/^(\d+)\s*\/\s*(.+)$/);
    if (!match) return;

    const numero = match[1];
    const nombre = (span.textContent || match[2] || '').replace(/\s+/g, ' ').trim();
    if (!nombre) return;

    // DIRECCIÓN: el elemento HERMANO INMEDIATO siguiente al <p> del título
    // (el "segundo párrafo dentro de la tarjeta"), no un contenedor ancestro
    // completo — así evitamos agarrar el texto del mapa/buscador.
    const textosHermanos = [];
    let hermano = p.nextElementSibling;
    let intentos = 0;
    while (hermano && intentos < 5 && textosHermanos.length < 4) {
      const texto = (hermano.textContent || '').replace(/\s+/g, ' ').trim();
      if (esTextoUtil(texto)) textosHermanos.push(texto);
      hermano = hermano.nextElementSibling;
      intentos++;
    }

    const direccion = textosHermanos[0] || null;

    // Teléfono/horario: buscamos SOLO dentro de esos hermanos de texto útil
    // (no en todo el ancestro, por la misma razón que la dirección).
    const textoParaRegex = textosHermanos.join(' ');
    const regexTelefono = /(\+?\d[\d\s().-]{6,}\d)/;
    const regexHorario =
      /(\d{1,2}[:.]\d{2}\s?(a|hs|-)\s?\d{1,2}[:.]\d{2}|\d{1,2}\s?a\s?\d{1,2}\s?hs)/i;

    const telefono = textoParaRegex.match(regexTelefono)?.[0] || null;
    const horarios = textoParaRegex.match(regexHorario)?.[0] || null;

    // Coordenadas: buscamos en un contenedor un poco más amplio (la tarjeta
    // completa), ya que el iframe/atributos de mapa sí suelen vivir ahí
    // dentro y esto no afecta al campo "direccion".
    let contenedorTarjeta = p.parentElement;
    let nivelesSubidos = 0;
    while (
      contenedorTarjeta &&
      nivelesSubidos < 4 &&
      !contenedorTarjeta.querySelector('iframe[src*="maps"], [data-lat]')
    ) {
      contenedorTarjeta = contenedorTarjeta.parentElement;
      nivelesSubidos++;
    }

    let coordenadas = null;
    if (contenedorTarjeta) {
      const iframeMapa = contenedorTarjeta.querySelector('iframe[src*="maps"]');
      if (iframeMapa) {
        const m = iframeMapa.src.match(/q=(-?\d+\.\d+),(-?\d+\.\d+)/);
        if (m) coordenadas = { lat: Number(m[1]), lng: Number(m[2]) };
      }
      if (!coordenadas) {
        const conLat = contenedorTarjeta.querySelector('[data-lat]');
        if (conLat) {
          const lat = conLat.getAttribute('data-lat');
          const lng = conLat.getAttribute('data-lng') || conLat.getAttribute('data-lon');
          if (lat && lng) coordenadas = { lat: Number(lat), lng: Number(lng) };
        }
      }
    }

    resultados.push({
      numero,
      nombre,
      direccion,
      horarios,
      telefono,
      coordenadas,
    });
  });

  // Dedupe por número + nombre
  const vistos = new Set();
  return resultados.filter((r) => {
    const clave = `${r.numero}-${r.nombre}`;
    if (vistos.has(clave)) return false;
    vistos.add(clave);
    return true;
  });
}

// Heurística de respaldo por DOM: busca tarjetas de sucursal repetidas.
function extraerSucursalesDesdeDom() {
  const selectoresCandidatos = [
    '[class*="sucursal" i]',
    '[class*="store" i]',
    '[class*="branch" i]',
    '[class*="local" i]',
  ];

  const candidatosSet = new Set();
  selectoresCandidatos.forEach((sel) => {
    document.querySelectorAll(sel).forEach((el) => candidatosSet.add(el));
  });

  let candidatos = Array.from(candidatosSet).filter((el) => {
    const texto = (el.textContent || '').trim();
    return texto.length > 15;
  });

  // Solo el nodo más externo de cada cadena anidada
  candidatos = candidatos.filter(
    (el) => !candidatos.some((otro) => otro !== el && otro.contains(el))
  );

  const regexTelefono = /(\+?\d[\d\s().-]{6,}\d)/;
  const regexHorario = /(\d{1,2}[:.]\d{2}\s?(a|hs|-)\s?\d{1,2}[:.]\d{2}|\d{1,2}\s?a\s?\d{1,2}\s?hs)/i;

  return candidatos.map((el) => {
    const texto = el.textContent.replace(/\s+/g, ' ').trim();

    const iframeMapa = el.querySelector('iframe[src*="maps"]');
    let coordenadas = null;
    if (iframeMapa) {
      const match = iframeMapa.src.match(/q=(-?\d+\.\d+),(-?\d+\.\d+)/);
      if (match) {
        coordenadas = { lat: Number(match[1]), lng: Number(match[2]) };
      }
    }
    const dataLat = el.getAttribute('data-lat');
    const dataLng = el.getAttribute('data-lng') || el.getAttribute('data-lon');
    if (!coordenadas && dataLat && dataLng) {
      coordenadas = { lat: Number(dataLat), lng: Number(dataLng) };
    }

    const telefonoMatch = texto.match(regexTelefono);
    const horarioMatch = texto.match(regexHorario);

    return {
      nombre: null,
      direccion: texto.slice(0, 120), // fallback: primeros caracteres del bloque
      horarios: horarioMatch ? horarioMatch[0] : null,
      telefono: telefonoMatch ? telefonoMatch[0] : null,
      coordenadas,
    };
  });
}

async function scrapearSucursales(browser) {
  console.log('\n=== [3/3] Scrapeando sucursales ===');
  let page = await browser.newPage();
  const paginaOriginal = page; // guardamos referencia para cerrarla al final
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
  );

  // Muchos store-locators (mapa de sucursales) no listan NADA hasta que el
  // navegador "sabe" dónde está el usuario. Le damos permiso de geolocalización
  // de entrada y le seteamos una ubicación fija (obelisco, CABA) para que el
  // widget arranque poblado sin depender de que el usuario acepte un popup.
  try {
    const context = browser.defaultBrowserContext();
    await context.overridePermissions(CONFIG.SUCURSALES_URL, ['geolocation']);
    await page.setGeolocation({ latitude: -34.6037, longitude: -58.3816 });
  } catch (err) {
    console.log('  (No se pudo forzar geolocalización, sigo igual)');
  }

  try {
    console.log(`Navegando a: ${CONFIG.SUCURSALES_URL}`);
    // Es una ruta hash de la SPA (React Router), igual que /beneficios#/...
    await page.goto(CONFIG.SUCURSALES_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    console.log('Esperando carga inicial de la SPA...');
    await new Promise((r) => setTimeout(r, 8000));

    // Comprobación de contenido: si el texto de la página no menciona
    // "sucursal", es señal de que el deep-link no cargó la sección esperada.
    const tituloInicial = await page.title();
    const previewTextoInicial = await page.evaluate(() =>
      (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300)
    );
    if (CONFIG.DEBUG) {
      console.log(`  Título de la página: "${tituloInicial}"`);
      console.log(`  Primeros 300 chars visibles: "${previewTextoInicial}"`);
    }

    const contieneSucursalTexto = await page.evaluate(() =>
      (document.body.innerText || '').toLowerCase().includes('sucursal')
    );

    // El hash de sucursales no carga el listado directamente: carga un
    // panel intermedio con un botón "Buscala ahora" (debajo de "Encontrá
    // la Sucursal Santander más cercana"). Hay que clickearlo para que
    // se dispare la búsqueda y aparezca el listado real de resultados.
    if (contieneSucursalTexto) {
      console.log('  Panel de sucursales detectado. Buscando botón "Buscala ahora"...');

      const paginasAntes = await browser.pages();

      const clickeoBuscar = await page.evaluate(() => {
        // El botón de SUCURSAL aparece primero en el DOM (antes que el de
        // "cajero"), así que tomamos el primer match de "Buscal[ao] ahora".
        const botones = Array.from(document.querySelectorAll('button, a'));
        const encontrado = botones.find((b) =>
          /buscal[ao]\s*ahora/i.test((b.textContent || '').trim())
        );
        if (encontrado) {
          encontrado.click();
          return true;
        }
        return false;
      });

      if (clickeoBuscar) {
        console.log('  Click en "Buscala ahora" realizado. Esperando que renderice el listado...');
        await new Promise((r) => setTimeout(r, 4000));

        // Si el click abrió una PESTAÑA NUEVA (target="_blank" o window.open),
        // cambiamos el foco de nuestras extracciones a esa pestaña.
        const paginasDespues = await browser.pages();
        if (paginasDespues.length > paginasAntes.length) {
          const paginaNueva = paginasDespues[paginasDespues.length - 1];
          console.log('  Se abrió una pestaña nueva, cambio el foco a ella.');
          await paginaNueva.bringToFront().catch(() => {});
          await paginaNueva
            .waitForSelector('body', { timeout: 15000 })
            .catch(() => {});
          await new Promise((r) => setTimeout(r, 3000));
          page = paginaNueva; // toda la extracción de acá en más usa esta pestaña
        }

        // Diagnóstico #2: qué quedó en pantalla después del click
        const tituloTrasClick = await page.title().catch(() => '(sin título)');
        const urlTrasClick = page.url();
        const previewTrasClick = await page
          .evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300))
          .catch(() => '');
        console.log(`  URL tras el click: ${urlTrasClick}`);
        console.log(`  Título tras el click: "${tituloTrasClick}"`);
        console.log(`  Primeros 300 chars tras el click: "${previewTrasClick}"`);

        await esperarCargaCompleta(page);
      } else {
        console.log('  No encontré ningún botón "Buscala ahora" para clickear.');
      }
    }

    // PLAN B: si cargar el hash directo no rindió nada con "sucursal" en
    // pantalla (deep-link roto, algo común en esta SPA según vimos con
    // otros links que devolvían "página se perdió"), navegamos a la home
    // de /personas y hacemos CLICK real en el link de sucursales, tal
    // como lo haría un usuario navegando manualmente.
    if (!contieneSucursalTexto) {
      console.log('  El hash directo no muestra contenido de sucursales. Probando plan B: navegar desde /personas y hacer click...');
      await page.goto('https://www.santander.com.ar/personas', {
        waitUntil: 'networkidle2',
        timeout: 60000,
      });
      await new Promise((r) => setTimeout(r, 4000));

      const clickeoNav = await page.evaluate(() => {
        const candidatos = Array.from(document.querySelectorAll('a, button'));
        const encontrado = candidatos.find((el) => {
          const texto = (el.textContent || '').toLowerCase();
          const href = (el.getAttribute('href') || '').toLowerCase();
          return (
            texto.includes('sucursal') ||
            texto.includes('cajero') ||
            href.includes('sucursal') ||
            href.includes('cajero')
          );
        });
        if (encontrado) {
          encontrado.click();
          return true;
        }
        return false;
      });

      if (clickeoNav) {
        console.log('  Encontré y clickeé un link/botón de sucursales en la navegación.');
        await new Promise((r) => setTimeout(r, 6000));

        const tituloDespues = await page.title();
        const previewDespues = await page.evaluate(() =>
          (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300)
        );
        console.log(`  URL actual: ${page.url()}`);
        console.log(`  Título tras el click: "${tituloDespues}"`);
        console.log(`  Primeros 300 chars tras el click: "${previewDespues}"`);
      } else {
        console.log('  No encontré ningún link/botón con texto "sucursal" o "cajero" en la nav de /personas.');
      }
    }

    // Artefactos de diagnóstico (screenshot + listado de frames), solo en
    // modo DEBUG: no son necesarios para el flujo normal de extracción.
    if (CONFIG.DEBUG) {
      if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
      const screenshotPath = path.join(OUTPUT_DIR, 'debug-sucursales.png');
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
      console.log(`  Screenshot de diagnóstico guardada en: ${screenshotPath}`);

      const frames = page.frames();
      console.log(`  Frames detectados en la página: ${frames.length}`);
      frames.forEach((f, i) => console.log(`    [frame ${i}] ${f.url()}`));
    }

    // Espera explícita a que se dibuje ALGO del buscador/listado de
    // sucursales antes de seguir (input de búsqueda o tarjetas de sucursal).
    console.log('Esperando selector del buscador/listado de sucursales...');
    await page
      .waitForSelector(
        'input, [class*="sucursal" i], [class*="store" i], [class*="branch" i], [class*="local" i]',
        { timeout: 30000 }
      )
      .catch(() => {
        console.log('  (timeout esperando selector de sucursales en el frame principal, sigo igual)');
      });

    await esperarCargaCompleta(page);

    // Best-effort: si hay un botón tipo "Ver todas"/"Ver lista"/"Listado",
    // lo clickeamos — algunos store-locators arrancan en vista mapa y no
    // renderizan las tarjetas de texto hasta cambiar a vista lista.
    try {
      const clickeoLista = await page.evaluate(() => {
        const textosBoton = ['ver todas', 'ver lista', 'listado', 'ver sucursales'];
        const botones = Array.from(document.querySelectorAll('button, a'));
        const encontrado = botones.find((b) =>
          textosBoton.some((t) => (b.textContent || '').toLowerCase().includes(t))
        );
        if (encontrado) {
          encontrado.click();
          return true;
        }
        return false;
      });
      if (clickeoLista) {
        console.log('  Encontré y clickeé un botón de "ver lista", esperando render...');
        await new Promise((r) => setTimeout(r, 3000));
      }
    } catch (err) {
      // no rompe el flujo
    }

    // Best-effort: si hay un input de búsqueda de sucursal (típico store-locator),
    // probamos escribir una ciudad/provincia común y disparar el buscador.
    // Si el sitio no tiene ese patrón, esto no rompe nada (queda en try/catch).
    try {
      const inputBusqueda = await page.$(
        'input[placeholder*="direcc" i], input[placeholder*="localidad" i], input[placeholder*="sucursal" i], input[type="search"]'
      );
      if (inputBusqueda) {
        await inputBusqueda.click({ clickCount: 3 });
        await inputBusqueda.type('Buenos Aires', { delay: 60 });
        await page.keyboard.press('Enter').catch(() => {});
        await new Promise((r) => setTimeout(r, 3000));
      }
    } catch (err) {
      console.log('  (No se encontró buscador interactivo de sucursales, sigo con el listado tal cual carga)');
    }

    console.log('Realizando scroll progresivo para activar lazy-loading...');
    await scrollHastaEstabilizar(page);
    await esperarCargaCompleta(page);

    // Probamos el frame principal primero (caso normal, sin iframes).
    let sucursales = await page.evaluate(extraerSucursalesDesdeJsonLd);

    if (!sucursales || sucursales.length === 0) {
      sucursales = await page.evaluate(extraerSucursalesDesdeEstructura);
    }

    if (!sucursales || sucursales.length === 0) {
      sucursales = await page.evaluate(extraerSucursalesDesdeDom);
    }

    // Si el frame principal no dio nada, recorremos TODOS los iframes de
    // la página probando las mismas 3 estrategias en cada uno. Esto cubre
    // el caso (muy probable acá, según el diagnóstico) de que el
    // buscador/listado de sucursales esté embebido en un widget de terceros.
    if (!sucursales || sucursales.length === 0) {
      console.log('  Sin resultados en el frame principal, probando dentro de cada iframe...');
      const framesHijos = page.frames().filter((f) => f !== page.mainFrame());

      for (const frame of framesHijos) {
        try {
          let resultadoFrame = await frame.evaluate(extraerSucursalesDesdeJsonLd);
          if (!resultadoFrame || resultadoFrame.length === 0) {
            resultadoFrame = await frame.evaluate(extraerSucursalesDesdeEstructura);
          }
          if (!resultadoFrame || resultadoFrame.length === 0) {
            resultadoFrame = await frame.evaluate(extraerSucursalesDesdeDom);
          }
          if (resultadoFrame && resultadoFrame.length > 0) {
            console.log(`  + Encontré ${resultadoFrame.length} sucursales dentro del frame: ${frame.url()}`);
            sucursales = resultadoFrame;
            break;
          }
        } catch (err) {
          // Frames cross-origin (ej: maps.google.com) tiran error de acceso
          // por política de seguridad del navegador; los salteamos.
          console.log(`  (No se pudo leer el frame ${frame.url()}: ${err.message})`);
        }
      }
    }

    console.log(`Sucursales encontradas: ${sucursales.length}`);
    return sucursales;
  } catch (err) {
    console.error('Error scrapeando sucursales:', err.message);
    return [];
  } finally {
    // Cerramos la pestaña activa (puede ser la original o una nueva que
    // se haya abierto tras el click en "Buscala ahora") y, si quedó una
    // pestaña extra abierta, la cerramos también.
    await page.close().catch(() => {});
    if (page !== paginaOriginal) {
      await paginaOriginal.close().catch(() => {});
    }
  }
}

// ============================================================
// ORQUESTADOR PRINCIPAL
// ============================================================
async function main() {
  console.log('Iniciando navegador...');
  const browser = await puppeteer.launch({
    headless: CONFIG.HEADLESS,
    defaultViewport: { width: 1366, height: 900 },
    args: CONFIG.HEADLESS ? [] : ['--start-maximized'],
    // Usa el Chrome ya instalado en el sistema en vez de que Puppeteer
    // descargue su propia copia. Ajustar la ruta si el Chrome local está
    // en otra ubicación, o quitar esta línea si se prefiere que Puppeteer
    // gestione su propio binario (requiere `npx puppeteer browsers install chrome`).
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });

  try {
    const promociones = await scrapearPromociones(browser);
    const productos = await scrapearProductos(browser);
    const sucursales = await scrapearSucursales(browser);

    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    // Guardamos cada sección en su propio archivo JSON dentro de /data
    fs.writeFileSync(
      OUTPUT_FILE_PROMOCIONES,
      JSON.stringify(promociones, null, 2),
      'utf-8'
    );
    console.log(`✔ promociones.json guardado (${promociones.length} ítems) en: ${OUTPUT_FILE_PROMOCIONES}`);

    fs.writeFileSync(
      OUTPUT_FILE_PRODUCTOS,
      JSON.stringify(productos, null, 2),
      'utf-8'
    );
    console.log(`✔ productos.json guardado (${productos.length} ítems) en: ${OUTPUT_FILE_PRODUCTOS}`);

    fs.writeFileSync(
      OUTPUT_FILE_SUCURSALES,
      JSON.stringify(sucursales, null, 2),
      'utf-8'
    );
    console.log(`✔ sucursales.json guardado (${sucursales.length} ítems) en: ${OUTPUT_FILE_SUCURSALES}`);

    console.log(
      `\nResumen -> promociones: ${promociones.length} | productos: ${productos.length} | sucursales: ${sucursales.length}`
    );
  } catch (err) {
    console.error('Error general en el scraping:', err);
  } finally {
    await browser.close();
  }
}

main();
