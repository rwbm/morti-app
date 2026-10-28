# Modelo de muebles de Morti

La aplicación apunta a muebles paramétricos hechos con tableros. Las plantillas
deben facilitar el inicio del diseño sin restringir las combinaciones posibles.
Los controles nuevos y las pantallas que se modifiquen se escribirán en español.

## Separación de responsabilidades

Un mueble debe poder resolver de forma independiente:

| Parte | Decisiones que le corresponden |
| --- | --- |
| Frente | Abierto, puertas y sentido de apertura, frentes de cajón, holguras |
| Interior | Estantes, divisiones, cajones internos, espacio para colgar |
| Laterales | Izquierdo y derecho, espesor, dimensiones, encuentros |
| Tapa superior | Presencia, espesor, vuelo y encuentro con los laterales |
| Piso | Presencia, espesor y posición respecto del apoyo |
| Fondo | Presencia, espesor y montaje: ranurado, superpuesto o embutido |
| Apoyo | Sin patas, patas o zócalo; altura, sección y ubicación |

La estructura exterior pertenece al mueble. Las divisiones y los frentes
pertenecen a sus compartimentos. Un estante interior no divide una puerta
automáticamente: una puerta puede cubrir varios espacios interiores.

## Primera implementación

- Los límites iniciales de ancho por columna y alto por módulo pasan a 3 m.
  La migración amplía los valores anteriores de 1,2 m una sola vez y conserva
  límites personalizados distintos de ese valor. No modifica las dimensiones.
- `FurnitureModule.interior.shelfCount` representa estantes interiores separados
  del frente. El valor ausente equivale a cero. Se distribuyen a igual distancia.
- Los estantes generan paneles horizontales con claves estables y asociación al
  módulo, por lo que participan de la vista 3D, materiales, despiece y exportación.
  Terminan detrás del frente y delante del fondo.
- Se conservan al cambiar entre un frente abierto y puertas. En un módulo de
  cajones se mantienen guardados pero no se generan ni se pueden editar, para
  evitar interferencias con las cajas. Al volver a puertas reaparecen.
- Yjs, los archivos `.morti` y la normalización de IA conservan el interior.
- Los documentos existentes se leen sin exigir la presencia del campo nuevo.
- El esquema pasa a versión 4 y el compilador a versión 2.

El campo histórico `type` sigue siendo el adaptador de los frentes existentes.
Esto permite entregar la primera mejora sin romper los proyectos anteriores.
No se agregan tipos como `puertas-con-estantes` por cada combinación.

## Estructura y patas

La pestaña «Estructura» muestra los controles en un panel a la derecha del 3D,
con la misma disposición que «Estilo». En pantallas pequeñas se apilan el 3D y
los controles. La pestaña elegida se conserva en el estado local del editor.

- `FurnitureDoc.construction` separa la estructura del contenido. Los documentos
  sin este campo conservan ambos laterales, tapa, piso y fondo, sin patas.
- Cada lateral exterior se activa por separado. La tapa y el piso se activan para
  todas las columnas; las divisiones interiores se conservan. Estos controles no
  cambian las medidas nominales ni la disposición de los compartimentos.
- Al quitar el fondo desaparecen sus paneles y ranuras, y se recupera la reserva
  trasera para el interior. Las cajas y ranuras de los cajones se conservan.
- Las patas opcionales tienen sección cuadrada, alto y retiro desde el borde del
  piso. Se generan cuatro por columna. Se valida que no se superpongan y que
  exista un piso donde apoyarlas. Se incluyen como piezas «Pata» en el despiece.
- Su base queda en el suelo y su cara superior coincide con la cara inferior del
  piso. Para eso se eleva todo el cuerpo, descontando la distancia que ya existía
  entre el borde inferior de los laterales y el piso. No cambia el espacio útil.
- La configuración participa de la sincronización, deshacer/rehacer, archivos
  `.morti`, miniaturas, vista frontal y exportación 3D. La IA conserva la estructura
  elegida por el usuario al regenerar los compartimentos.
- El esquema actual es 6 y el compilador 5. La inicialización agrega la estructura
  por defecto a los documentos anteriores sin cambiar su geometría.

Los espesores ahora se definen por grupo en Estructura: cuerpo/estantes, puertas,
fondo del mueble, frentes de cajón, laterales/traseras de cajón y fondos de cajón.
Los proyectos anteriores heredan sus espesores personalizados una sola vez.
El fondo conserva el montaje ranurado existente. Aún faltan espesores por pieza, otros encuentros,
fondos superpuestos, patas de otros tipos y zócalos.

## Próximos pasos

El orden de implementación y los criterios de aceptación se mantienen en
[plan-de-evolucion.md](plan-de-evolucion.md).

1. Ampliar la estructura exterior con espesores individuales y variantes de montaje.
2. Reemplazar el frente histórico por una configuración explícita y separar
   los cajones interiores de sus frentes. Migrar los módulos existentes.
3. Agregar otros tipos de patas y zócalos usando la misma separación entre apoyo
   y cuerpo del mueble.
4. Permitir posiciones individuales de estantes y divisiones, además del reparto
   uniforme. Separar divisiones estructurales de estantes removibles.
5. Construir plantillas de biblioteca, ropero y placard usando el mismo modelo.
   Una cama requerirá largueros y soporte de colchón propios; no se representará
   artificialmente como una columna de armario.

Cada paso debe incluir persistencia, migración, geometría, despiece y controles.
Las validaciones geométricas actuales comprueban espacio y holguras; no calculan
resistencia de tableros, carga admisible ni selección de herrajes.

## Verificación

`npm test` comprueba combinaciones de frentes e interiores, dimensiones de las
piezas, compatibilidad anterior, migración de límites, sincronización Yjs y
exportación/importación, piezas exteriores, contacto de las patas con el piso y
convergencia de cambios simultáneos en la estructura. `npm run typecheck` y `npm run build` verifican la
integración de la aplicación.
