# Plan de evolución de Morti

Objetivo: diseñar muebles hechos con tableros a partir del espacio disponible,
con una interfaz sencilla y un despiece que acompañe las decisiones constructivas.
Todo control nuevo se presenta en español. Cada etapa se entrega por separado.

## Base disponible

- Frentes abiertos o con puertas y estantes interiores independientes.
- Cajones, piezas exteriores opcionales y patas cuadradas configurables.
- Pestañas Diseño, Despiece, Estructura y Estilo.
- Despiece en mm con agrupación compartida, ranuras y cantidades verificadas.
- Persistencia local, sincronización Yjs, importación/exportación y compatibilidad.

## 1. Espesores por grupo de piezas — primera entrega

Estado: implementado. Verificado con pruebas de herencia de espesores anteriores,
persistencia y encastres con frentes y laterales de diferentes espesores.

Mostrar en Estructura seis espesores en mm: cuerpo/estantes, puertas, fondo del
mueble, frentes de cajón, laterales/traseras de cajón y fondos de cajón.

Separar los valores que hoy se comparten. Mantener los espesores reales de los
proyectos existentes, incluso si fueron personalizados; no cambiar sus fondos a
un espesor «típico» automáticamente. Recalcular interiores y ranuras y verificar
el encastre de fondos con frentes y cajas de distinto espesor.

Aceptación: 3D y despiece reflejan cada espesor, los proyectos anteriores conservan
sus piezas, y los cambios sobreviven a deshacer/rehacer e importación/exportación.

## 2. Medidas exteriores finales

Estado: siguiente entrega.

Agregar un modo explícito de medidas exteriores, manteniendo el modo nominal de
los proyectos anteriores hasta que el usuario elija convertirlos.

- Ancho: cara exterior a cara exterior de laterales.
- Alto: suelo a punto superior, incluyendo patas y tapa.
- Profundidad: trasera a frente cerrado, incluyendo puertas.
- Reparto inicial proporcional del espacio interior; permitir luego fijar huecos
  útiles y repartir el espacio restante.

Resolver primero un cuerpo rectangular con los encuentros actuales. Mantener
fijas las dimensiones exteriores al cambiar espesores. Avisar si las piezas o
compartimentos dejan de caber. Mostrar el espacio útil resultante en mm.

Aceptación: un mueble de 2000 × 800 × 450 mm mantiene esas dimensiones en el
modelo y en el cálculo de sus límites, con y sin patas y al cambiar espesores.

## 3. Encuentros y montajes

Tapa/piso entre laterales o cubriéndolos; fondo ranurado, embutido o superpuesto;
puertas dentro del hueco o superpuestas. Cada opción debe definir dimensiones,
posiciones, holguras y mecanizados, con ejemplos numéricos de referencia.

## 4. Materiales constructivos

Separar material, espesor, acabado y veta. El acabado visual ya existe; elegir
material será opcional para comenzar. Incorporar material por grupo y después
excepciones por pieza. Mantener separadas piezas de distinto material en el
despiece. Agregar tapacantos y costos después de resolver su impacto dimensional.

### Más maderas y superficies en Estilo

Ampliar el catálogo visual con más maderas y superficies: diferentes tonos y vetas
de roble, pino, nogal y otras maderas; melaminas lisas y símil madera; MDF pintado,
laqueados y laminados. Incorporar texturas y acabados mate, satinado y brillante,
con vistas previas claras y nombres en español. Evaluar luego superficies como
metal, vidrio y piedra para piezas que las admitan.

Permitir aplicar un acabado al conjunto o a grupos de piezas. Diferenciar la
apariencia visual del material constructivo: cambiar una textura en Estilo no
debe modificar espesores, medidas ni despiece. No presentar una textura como
garantía de disponibilidad comercial o propiedades estructurales.

## 5. Interior y plantillas

Estantes con posiciones individuales, divisiones, espacio para colgar y cajones
internos separados del frente. Plantillas de biblioteca, placard, ropero y bajo
mesada que usen estas reglas. Otros tipos de patas y zócalos. La cama tendrá sus
propias piezas —largueros, cabecera y soporte— cuando la base de tableros esté firme.

## Forma de avanzar

Cada entrega incluye modelo, persistencia, geometría, despiece, controles y
verificación de casos conocidos. Evitar expandir una entrega con decisiones de
las siguientes. No convertir proyectos existentes silenciosamente al modo nuevo.
No incorporar cálculos de resistencia ni prometer un plano de fabricación completo
antes de resolver herrajes, tapacantos y compensaciones de corte.
