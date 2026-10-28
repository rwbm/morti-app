# Revisión de unidades y despiece

## Unidades

El modelo y Yjs usan metros. Las entradas del editor se guardan con resolución
de 1 mm. El despiece convierte a milímetros al presentar valores: `0.018 m`
se muestra como `18 mm`. Los ángulos se calculan en radianes y se muestran en grados.

Tabla y fichas usan el mismo formateador, con coma decimal y sin separadores de
miles. Los valores derivados conservan hasta 0,001 mm de precisión de cálculo;
eso no representa una tolerancia de fabricación. Las ranuras de un cuarto del
espesor de un tablero de 18 mm conservan su profundidad de 4,5 mm.

## Correcciones

- La tabla mostraba metros sin unidad mientras las fichas mostraban milímetros.
  Ahora toda dimensión lineal del despiece lleva encabezado o sufijo en mm.
- Las fichas muestran medidas aun cuando no están seleccionadas.
- La agrupación de piezas incluye orientación y todos los datos de mecanizado,
  incluido el giro de las ranuras. Tabla y fichas comparten cálculo, orden y códigos.
- El resumen de mecanizados distingue pieza destino, cara, posición, dimensiones,
  profundidad, giro y condición pasante. Las cantidades son totales del grupo.
- Las ranuras verticales del fondo se alinean con el panel de cada módulo; antes
  se generaban varias ranuras del alto completo del lateral en la misma posición.
- El fondo de cada cajón se prolonga en profundidad para entrar en las ranuras
  del frente y la trasera. Antes terminaba junto con los laterales y quedaba corto.
- El compilador deja de redondear dimensiones derivadas y operaciones a mm enteros.
  Versión del compilador: 4. La resolución de entrada del editor no cambia.

## Caso comprobado

Una columna nominal de 450 mm, módulo de 2000 mm, profundidad de 450 mm,
dos puertas y cuatro estantes interiores, con la configuración predeterminada:

| Pieza | Ancho × largo × espesor (mm) |
| --- | --- |
| Lateral | 450 × 2040 × 18 |
| Piso o tapa | 428 × 460 × 18 |
| Estante interior | 428 × 398 × 18 |
| Hoja de puerta | 210 × 1974 × 18 |
| Fondo de módulo | 437 × 1987 × 20 |

El ancho nominal de columna es entre ejes de laterales. Con ambos laterales
presentes, el ancho exterior de este ejemplo es 468 mm. La prolongación de los
laterales agrega 20 mm arriba y abajo: el alto exterior sin patas es 2040 mm.
La profundidad del piso y la tapa incluye el vuelo que ya tenía el compilador.
El fondo predeterminado es de 20 mm: es una configuración existente, no una
conversión equivocada de unidades. No se modifica automáticamente.

## Alcance de la verificación

Las pruebas contrastan medidas conocidas, encastre del fondo de los cajones en
cuatro caras, alineación de ranuras, fracciones de mm y agrupación de mecanizados.
Se suman a las pruebas de estantes, patas, piezas opcionales y persistencia.

Esto verifica coherencia con la geometría generada. No constituye todavía un
plano completo de fabricación: no se calculan tapacantos, compensaciones por
ancho de sierra, resistencia, ni todos los alojamientos de bisagras y correderas.
Las ranuras se representan mediante contornos; la geometría CSG exportada resta
las perforaciones, pero no el volumen de las ranuras.
