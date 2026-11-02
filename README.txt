 Scraper de beneficios, productos y sucursales - Banco Santander Argentina

Este script accede al portal oficial de Banco Santander Argentina (www.santander.com.ar) y extrae, en una sola corrida, tres conjuntos de datos: las promociones vigentes (www.santander.com.ar/personas/beneficios), la oferta de productos financieros (cuentas, préstamos, inversiones y seguros) y la red de sucursales cercanas (www.santander.com.ar/personas#/cajeros-y-sucursales). Cada conjunto se guarda en su propio archivo JSON dentro de la carpeta data/.

 Estructura del proyecto

santander-scraping-promociones-27-septiembre/
├── index.js
├── package.json
├── package-lock.json
├── README.txt
├── .gitignore
└── data/
    ├── promociones.json
    ├── productos.json
    └── sucursales.json

Los archivos de data/ se generan (y se sobreescriben) cada vez que se corre node index.js. Se incluyen en el repositorio con el resultado de la última ejecución, como evidencia de que el script funciona de punta a punta.

 Requisitos
- Node.js instalado (v16 o superior recomendado)
- npm (administrador de paquetes de Node)
- Un navegador Chrome disponible para Puppeteer (ver "Solución de problemas" si falta)

 Configuración
Al inicio de index.js, el objeto CONFIG expone dos flags:
- HEADLESS (por defecto true): corre el navegador sin ventana visible. Para debugging manual se puede poner en false.
- DEBUG (por defecto false): habilita logs verbosos y una captura de pantalla de diagnóstico (data/debug-sucursales.png) durante el módulo de sucursales. Se recomienda dejarlo en false para una corrida desatendida.

 Uso
1. Instalar las dependencias: npm install
2. (Solo la primera vez, o si Puppeteer no encuentra el navegador) npx puppeteer browsers install chrome
3. Ejecutar: node index.js
4. El resultado queda en:
   - ./data/promociones.json: beneficios bancarios activos por marca, con descuento o cuotas, condiciones y vigencia.
   - ./data/productos.json: cuentas, paquetes, préstamos, inversiones y seguros, con la Tasa Nominal Anual (TNA) cuando está disponible y las condiciones.
   - ./data/sucursales.json: número identificador, nombre y dirección (calle, altura y barrio) de las sucursales cercanas.
   El contenido exacto de los tres archivos varía en cada corrida, porque refleja el estado real del sitio en ese momento (las promociones rotan).

 Cómo funciona (resumen)
1. Abre un único navegador (Chrome detectado automáticamente) y ejecuta tres módulos en orden: promociones, productos y sucursales.
2. Promociones: mientras la página de beneficios carga, escucha las respuestas de red (page.on('response')) y busca, entre las que devuelven JSON, un array con forma de listado de beneficios (función pareceListaDeBeneficios), sin asumir el nombre de ningún endpoint. Si lo encuentra, usa esos datos ya estructurados. Si no, cae a una extracción por DOM: detecta las tarjetas y hace click en cada una para leer su detalle.
3. Productos: recorre 6 páginas hub (cuentas-y-tarjetas, prestamos/todos-los-prestamos, prendarios/prestamos-prendarios, inversiones, cuentas-y-paquetes y seguros). En cada una toma los links de producto y entra a cada detalle. Si un hub no tiene links de detalle, extrae las tarjetas directamente del hub.
4. Sucursales: abre el hash #/cajeros-y-sucursales, que muestra un panel intermedio con el botón "Buscala ahora". El script lo clickea, espera a que renderice el listado y lo parsea.
5. Cada módulo se reintenta hasta 3 veces si devuelve una lista vacía.
6. Si un módulo termina vacío después de los reintentos y ya existe una versión previa del archivo en data/, se conserva la anterior en lugar de pisarla con un array vacío.
7. Al final guarda los tres JSON, informa por consola la cantidad de ítems de cada uno y muestra un resumen. Si algún módulo falló, aparece una línea con la marca ⚠.

 Resultado de la última corrida (02/11/2026)
- Promociones: 20 tarjetas candidatas detectadas, 18 promociones guardadas. La API de beneficios no fue identificada, por lo que se usó la extracción por DOM (respaldo).
- Productos: 15 productos únicos procesados en las 6 categorías. Se descartaron 6 resultados que no eran productos: 4 títulos de sección ("Cuentas y Paquetes") en cuentas-y-tarjetas y 2 enlaces que respondieron con la página de error del sitio ("Parece que esta página se perdió") en préstamos. Las categorías prendarios y cuentas-y-paquetes no tienen links de detalle, por lo que se extrajeron sus tarjetas del hub.
- Sucursales: 10 sucursales guardadas.
- No hubo módulos con fallas (ninguna línea con ⚠).

 Cambios respecto a la entrega anterior (corrida del 24/10: 20 promociones, 16 productos, 10 sucursales)
El sitio actualiza sus promociones y su catálogo periódicamente, así que es normal que las cantidades varíen entre corridas:
- Las promociones pasaron de 20 a 18 por la rotación normal de beneficios.
- Los productos pasaron de 16 a 15: en la corrida anterior figuraba "Súper Préstamo Personal", cuyo enlace en esta corrida respondió con la página de error del sitio y fue descartado por el filtro de no-productos.
- Las sucursales se mantienen en 10.
- No hubo cambios en el código (index.js).

 Módulos y decisiones técnicas

1. Promociones (SPA con ruteo por hash)
El sitio no es un e-commerce estático sino una SPA (React) con ruteo por hash (#/beneficios, #/cajeros-y-sucursales) y renderizado asincrónico. Para esperar el contenido real el script combina:
- waitForSelector con timeouts.
- Auto-scroll progresivo (scrollHastaEstabilizar), que mide la altura del body en cada vuelta hasta que deja de crecer, para forzar el lazy-loading de tarjetas e imágenes.
- Polling activo (esperarCargaCompleta) que revisa si el texto "Cargando..." sigue presente antes de dar por terminada la carga.
Sobre el parámetro brandId=0740 de la URL de beneficios: los resultados incluyen promociones de múltiples comercios en la misma corrida (Café Martínez, Jumbo, Cabify, entre otros), lo que indica que ese parámetro no filtra por un comercio puntual, sino que corresponde al identificador del propio Santander como cliente de la plataforma de beneficios.

2. Productos (adaptación al dominio bancario)
Al no tratarse de un supermercado con precio de lista ni SKU, la extracción se adaptó al dominio. Santander no expone schema.org/Product, por lo que se prioriza la lectura de JSON-LD y, si no existe, se usa una heurística de DOM que busca por regex la TNA, la bonificación, los montos y las condiciones de contratación en el texto visible. Cuando una categoría no tiene links de detalle, se extraen las tarjetas del hub con selectores genéricos (article, [class*="card"], div[class*="product"], h2/h3). Un filtro descarta lo que no es un producto: páginas de error, títulos de sección y pestañas.

3. Sucursales
La vista de resultados muestra, por cada sucursal, un <p> con un <span> (número y nombre, con el formato "NÚMERO / Nombre"). La dirección se toma del elemento hermano inmediato siguiente al título, para no confundirla con la distancia en metros ni con textos del widget de mapa (que se descartan con una lista de exclusión). El script también maneja el caso de que el click en "Buscala ahora" abra una pestaña nueva del navegador. Los campos telefono, horarios y coordenadas quedan en null: esa vista de resultados no los expone (solo aparecen en el detalle individual de cada sucursal). No es un error de extracción.

4. Robustez ante cambios de build (styled-components)
El frontend usa styled-components, que regenera clases CSS hasheadas en cada deploy. El script evita depender de esos nombres volátiles y detecta patrones estructurales estables (por ejemplo, un <p> con un <span> adentro cuyo texto cumple el formato "NÚMERO / Nombre"), lo que le da mayor durabilidad ante futuras actualizaciones del sitio.

5. Tolerancia a fallos
El sitio ocasionalmente falla al navegar (timeouts, o el error "Navigating frame was detached" cuando la página se re-renderiza durante la carga). Para que una corrida no se pierda por un fallo transitorio:
- Cada módulo se reintenta hasta 3 veces si devuelve una lista vacía.
- El detalle de cada producto se reintenta una vez con una condición de carga menos estricta (domcontentloaded).
- Si un módulo queda vacío y ya hay una versión previa en data/, se conserva la anterior.
- El cierre del navegador ignora el error EBUSY que Windows puede lanzar al borrar el perfil temporal de Chrome: ocurre después de guardar los resultados y no los afecta.

 Estructura de los datos
- promociones.json y productos.json: nombre, precio, precio_descuento, imagen, codigo, descripcion, condiciones, url_producto.
- sucursales.json: numero, nombre, direccion, horarios, telefono, coordenadas.
Los campos que el sitio no expone quedan en null.

 Solución de problemas comunes
- Error: Could not find Chrome (ver. X.X.X.X): el script busca el navegador automáticamente en este orden: (1) la variable de entorno CHROME_PATH, si está definida; (2) el Chrome que descarga Puppeteer; (3) un Chrome instalado en el sistema (rutas habituales de Windows, macOS y Linux). Si no encuentra ninguno, correr npx puppeteer browsers install chrome en la carpeta del proyecto. Si el entorno bloquea esa descarga (antivirus o firewall), alcanza con tener Google Chrome instalado, o indicar su ruta con CHROME_PATH.
- Algún módulo devuelve un array vacío o aparece una línea con ⚠: revisar la consola, ya que el script loguea en qué paso se cortó (timeout de selector, error de página, etc.). Volver a correr suele resolverlo cuando el fallo es transitorio. Activar CONFIG.DEBUG = true agrega logs adicionales y una captura de pantalla del módulo de sucursales.

 Pendientes / próximas mejoras (no bloqueantes para esta entrega)
1. La API interna de beneficios no fue identificada en las corridas actuales, por lo que las promociones se obtienen por DOM. Si el sitio la expusiera, el script la usaría automáticamente.
2. Obtener teléfono, horarios y coordenadas de las sucursales requeriría entrar al detalle individual de cada una.
3. El listado de sucursales corresponde a las más cercanas que devuelve el sitio (10 por corrida), no a la red completa.
