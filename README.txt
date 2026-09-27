# Scraper de Beneficios, Productos y Sucursales - Banco Santander Argentina

Script automatizado de web scraping desarrollado en Node.js con Puppeteer. Extrae y procesa de forma estructurada las promociones vigentes, la oferta de productos financieros y la red de sucursales del portal oficial de Banco Santander Argentina.

---

## Estructura del Proyecto

supermercado-scraper/
├── index.js
├── package.json
├── package-lock.json
├── README.txt
├── .gitignore
└── data/
    ├── promociones.json
    ├── productos.json
    └── sucursales.json

Los archivos dentro de `data/` se generan (y se sobreescriben) cada vez que
se corre `node index.js`; se incluyen en el repositorio con el resultado de
la última ejecución a modo de evidencia de que el script funciona
end-to-end.

---

## Requisitos Previos

- Node.js (v16.0.0 o superior recomendado)
- npm (Administrador de paquetes de Node)
- Binario de Chrome para Puppeteer instalado (ver sección "Solución de problemas" si falta)

---

## Configuración

Al inicio de `index.js`, el objeto `CONFIG` expone dos flags relevantes:
- `HEADLESS` (default `true`): controla si el navegador corre sin ventana
  visible. Para debugging manual se puede poner en `false`.
- `DEBUG` (default `false`): habilita logs verbosos y una captura de
  pantalla de diagnóstico (`data/debug-sucursales.png`) durante el módulo
  de sucursales. Se recomienda dejarlo en `false` para una corrida
  desatendida (CI, cron, etc.).

---

## Instalación y Ejecución

1. Instalar las dependencias del proyecto:
   npm install

2. (Solo la primera vez, o si Puppeteer no encuentra el navegador) Instalar el
   binario de Chrome que Puppeteer necesita:
   npx puppeteer browsers install chrome

3. Ejecutar el script principal:
   node index.js

4. Resultados:
   Al finalizar el proceso, los datos extraídos se guardan automáticamente en
   la carpeta /data/ en tres archivos JSON estructurados, cada uno con su
   propio console.log de confirmación al guardarse:
   - /data/promociones.json: Beneficios bancarios activos por marca,
     porcentaje de ahorro o cuotas sin interés, tope de reintegro y
     vigencia.
   - /data/productos.json: Paquetes de cuentas, préstamos, inversiones y
     seguros, con Tasa Nominal Anual (TNA) cuando está disponible y
     condiciones/letra chica.
   - /data/sucursales.json: Red física con número identificador de
     sucursal, nombre y dirección exacta (calle, altura y barrio) de los
     resultados de búsqueda de sucursales cercanas.

   El contenido exacto de estos tres archivos varía en cada corrida porque
   refleja el estado real del sitio en el momento de ejecutar el script
   (las promociones bancarias rotan mes a mes).

---

## Notas Técnicas y Decisiones de Arquitectura

### 1. Extracción de promociones: interceptación de la API interna
La SPA de beneficios consulta, por detrás, un endpoint que devuelve el
listado de promociones ya estructurado (marca, descuento, tope, vigencia,
días válidos) en JSON. El script se suscribe a `page.on('response', ...)`
mientras la página carga, captura todas las respuestas con
`content-type: application/json`, y busca entre ellas —de forma genérica,
sin asumir un nombre de endpoint fijo— el array cuyos elementos tengan la
forma de un listado de beneficios (`pareceListaDeBeneficios`). Esto evita
depender de clicks simulados y parseo de DOM para obtener el detalle de
cada promoción.

Si en algún momento el sitio cambia de arquitectura y no se logra
identificar la respuesta de la API (por ejemplo, si pasa a servir los
datos ya embebidos en el HTML inicial), el script cae automáticamente a
una extracción por DOM con interacción de click card por card, que se
mantiene como respaldo.

Sobre el parámetro `brandId=0740` de la URL de beneficios: los resultados
observados incluyen promociones de múltiples comercios en la misma corrida
(Café Martínez, Jumbo, Cabify, entre otros), lo que indica que ese
parámetro no está filtrando por un comercio puntual, sino que corresponde
al identificador del propio Santander como cliente de la plataforma de
beneficios (patrón habitual en plataformas de fidelización que sirven a
varios bancos/comercios bajo un mismo dominio).

### 2. Manejo de Single Page Application (SPA)
El sitio no opera como un e-commerce estático, sino como una SPA con
ruteo por hash (React Router: `#/beneficios`, `#/cajeros-y-sucursales`) y
renderizado dinámico y asincrónico. El script combina:
- `waitForSelector` con timeouts para esperar contenido real antes de
  extraer.
- Auto-scroll progresivo (`scrollHastaEstabilizar`), que mide la altura
  del `body` en cada vuelta hasta que deja de crecer, para forzar el
  lazy-loading de tarjetas e imágenes.
- Polling activo (`esperarCargaCompleta`) que revisa si el texto
  "Cargando..." sigue presente antes de dar por terminada la carga.

### 3. Adaptación del modelo de datos al dominio bancario
Al no tratarse de un supermercado con precio de lista tradicional o SKU de
góndola, la lógica de extracción se adaptó a la naturaleza del dominio:
1. **Productos**: como Santander no expone `schema.org/Product` ni SKU, se
   prioriza la lectura de JSON-LD como primer intento y, si no existe, se
   cae a una heurística de DOM que busca la TNA (Tasa Nominal Anual),
   montos y condiciones de contratación por regex sobre el texto visible.
   Cuando una categoría no tiene links de detalle propios, se extraen las
   tarjetas directamente del hub con selectores genéricos (`article`,
   `[class*="card"]`, `div[class*="product"]`, `h2`/`h3`).
2. **Sucursales**: el hash `#/cajeros-y-sucursales` no carga un listado
   directo, sino un panel intermedio con un botón "Buscala ahora". El
   script detecta ese panel, hace click de forma automatizada, y maneja
   el caso de que ese click abra una pestaña nueva del navegador. Ya en el
   listado de resultados, se parsean los datos a partir del patrón
   estructural `<p>` con `<span>` (número de sucursal + nombre), tomando
   como dirección el elemento hermano inmediato siguiente al título, para
   no confundirla con la distancia en metros ni con textos del widget de
   mapa (se descartan explícitamente con una lista de exclusión). El
   teléfono y el horario de atención no están disponibles en esta vista de
   resultados (solo en el detalle individual de cada sucursal), por lo que
   quedan en `null`; no es un error de extracción, es información que esa
   pantalla no expone.

### 4. Robustez ante cambios de build (styled-components)
El frontend usa styled-components (React), que regenera clases CSS
hasheadas en cada deploy. El script evita depender de esos nombres de
clase volátiles y en su lugar detecta patrones estructurales estables
(ej. "un `<p>` con un `<span>` adentro cuyo texto matchea `NÚMERO /
Nombre`"), lo que le da mayor durabilidad frente a futuras
actualizaciones del sitio.

---

## Solución de Problemas Comunes

- **`Error: Could not find Chrome (ver. X.X.X.X)`**: correr
  `npx puppeteer browsers install chrome` en la carpeta del proyecto. Si el
  entorno bloquea la descarga (antivirus/firewall corporativo), se puede
  apuntar Puppeteer al Chrome ya instalado en el sistema agregando
  `executablePath` en `puppeteer.launch()`.
- **Alguna sección devuelve un array vacío**: revisar la consola — el
  script loguea en qué paso se cortó (timeout de selector, error de
  página, etc.). Activar `CONFIG.DEBUG = true` agrega logs adicionales y
  una captura de pantalla del estado del navegador en el módulo de
  sucursales.
