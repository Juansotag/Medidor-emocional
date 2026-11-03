# Medidor emocional en vivo

App web para eventos: mientras el expositor habla, el auditorio ubica su emoción en el medidor de cuatro cuadrantes (energía x agrado, al estilo de Marc Brackett) y envía una palabra. Una pantalla aparte muestra el medidor y la nube de palabras en tiempo real.

## Enlaces

| Vista | URL | Para qué |
|---|---|---|
| Participante | `https://medidor-emocional.up.railway.app/` | Nombre, casilla del medidor, una palabra, Enviar |
| Administrador / pantalla | `https://medidor-emocional.up.railway.app/admin?key=TU_CLAVE` | Medidor y nube en vivo, QR, descarga de Excel, borrar resultados |

El QR del panel apunta a la vista de participante. El botón "Pantalla" pone el panel en pantalla completa y oculta los botones de administración para proyectarlo.

## Variables de entorno

| Variable | Obligatoria | Descripción |
|---|---|---|
| `ADMIN_KEY` | Sí | Clave del enlace de administrador. Usa algo largo y difícil de adivinar. |
| `DATA_DIR` | Recomendada | Carpeta donde se guardan las reacciones. En Railway, la ruta del volumen (p. ej. `/data`). |
| `EVENT_TITLE` | No | Título que ven todos. Por defecto: "¿Cómo te hizo sentir?" |
| `PUBLIC_URL` | No | URL pública para el QR (por defecto `https://medidor-emocional.up.railway.app`). |

## Despliegue en Railway

1. Sube esta carpeta a un repositorio de GitHub (`git init`, `git add .`, `git commit -m "medidor"`, `git push`).
2. En Railway: **New Project → Deploy from GitHub repo** y elige el repositorio. Railway detecta Node y ejecuta `npm start`.
3. En **Variables** agrega `ADMIN_KEY` (y opcionalmente `EVENT_TITLE`).
4. **Persistencia:** el disco de Railway se borra en cada redeploy. Agrega un **Volume** al servicio montado en `/data` y define `DATA_DIR=/data`. Sin volumen la app funciona, pero un redeploy durante el evento borraría las respuestas.
5. En **Settings → Networking → Generate Domain** para obtener la URL pública.

## Desarrollo local

```bash
npm install
ADMIN_KEY=prueba npm start
# Participante: http://localhost:3000/
# Admin:        http://localhost:3000/admin?key=prueba
```

Para probar desde el celular en la misma red, abre el admin usando la IP del computador (`http://192.168.x.x:3000/admin?key=prueba`) para que el QR apunte a esa IP.

## Archivo Excel (.xlsx)

Una fila por reacción en formato Excel (`.xlsx`), hora de Bogotá:

`id, fecha, hora, nombre, cuadrante, descripcion_cuadrante, agrado_x, energia_y, palabra`

- `agrado_x`: de -5 (muy no agradable) a 5 (muy agradable), sin 0.
- `energia_y`: de -5 (muy baja) a 5 (muy alta), sin 0.
- `cuadrante`: rojo, amarillo, azul o verde.

## Detalles

- Una persona puede enviar varias reacciones a lo largo de la charla (hay una pausa de 3 segundos entre envíos para evitar dobles toques). El nombre queda recordado en su celular.
- La palabra se guarda en minúsculas y sin espacios, para que "Inspiración" e "inspiración" cuenten juntas en la nube.
- El color de cada palabra en la nube corresponde al cuadrante en el que más se envió.
- "Borrar resultados" no elimina los datos: los mueve a un archivo `respaldo_<fecha>.jsonl` dentro de `DATA_DIR`.
- Pensado para un solo servidor (una instancia en Railway), que aguanta sin problema un auditorio de varios cientos de personas.

## Estructura

```
server.js          Express + Socket.IO, API y CSV
public/index.html  Vista de participante
public/admin.html  Panel de administrador / pantalla
public/meter.js    Dibujo del medidor 10 x 10
public/style.css   Estilo visual (papel, colores pastel, letra a mano)
```
