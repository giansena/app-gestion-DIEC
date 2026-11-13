# DIEC flow

Aplicación web adaptable a móviles para organizar tareas del equipo. Incluye frontend estático, API Node.js, almacenamiento local de tareas, sincronización opcional de completadas con Azure SQL y recordatorios diarios simulados.

## Estructura

```text
flow/
├── .env.example
├── README.md
├── flow.css
├── flow.js
├── index.html
├── package.json
├── schema.sql
└── server.mjs
```

## Ejecutar localmente

Requiere Node.js 20 o superior.

```sh
cd flow
npm install
cp .env.example .env
npm start
```

Abrí `http://localhost:3000`. Las tareas se guardan en `flow/data/tasks.json`, que se crea al iniciar el servidor. No se guardan contraseñas ni credenciales SQL en el navegador.

## Azure SQL

1. Ejecuta [`schema.sql`](./schema.sql) en la base Azure SQL. El script crea `dbo.Clientes_Obras`, `dbo.Tareas` (incluida la clave foránea opcional del cliente/obra, el autor y los tres estados) y `dbo.Notificaciones`, y copia a `dbo.Tareas` las filas históricas de `dbo.CompletedTasks`, si existe.
2. Copia `.env.example` a `.env` y sustituye los placeholders `AZURE_SQL_SERVER`, `AZURE_SQL_DATABASE`, `AZURE_SQL_USER` y `AZURE_SQL_PASSWORD` por credenciales reales. No publiques `.env`.
3. Los clientes/obras, las tareas y las notificaciones se conservan localmente en archivos JSON. Al crear una tarea, el servidor genera un aviso para cada destinatario; al editarla, avisa solo a quienes se agregaron. Las tareas y los avisos se sincronizan con Azure SQL; si Azure no está disponible, conserva los cambios pendientes y reintenta cada cinco minutos.

La autenticación por selección de usuario es **simulada** y sirve únicamente para una demostración controlada. Antes de publicar la app, reemplázala por autenticación real (por ejemplo, Microsoft Entra ID), valida permisos en el servidor y usa almacenamiento compartido y persistente para despliegues con varias instancias.

## Recordatorios

El servidor agrupa cada día a las 08:00 las tareas abiertas por destinatario y escribe un recordatorio personalizado en su log. Es una simulación: no se envían notificaciones push, correo ni SMS. `APP_TIMEZONE` controla la zona horaria del cron y por defecto es `America/Argentina/Buenos_Aires`. Para notificaciones reales, integra un proveedor de push/correo en `sendDailyReminders`.

## Experiencia móvil

- Diseño responsive con controles táctiles de al menos 48 px, áreas seguras de pantalla y transiciones que respetan `prefers-reduced-motion`.
- La sesión simulada persiste en `localStorage` hasta cerrar sesión; las tareas y credenciales no se almacenan en el navegador.
- La vista personal es la inicial; “Todas” muestra las tareas de todo el equipo. “Activas” presenta dos secciones independientes (“Pendientes” y “En proceso”), con su cantidad y distintivo visual; el acceso al historial de completadas está al pie del tablero.
- El tablero permite administrar clientes/obras y asociarlos opcionalmente a nuevas tareas. Los cambios de estado piden confirmación; una tarea completada puede reabrirse como pendiente desde “Completadas”.
- Las tareas activas pueden editarse para ajustar descripción, destinatarios, cliente/obra y vencimiento; la fecha y el autor originales se conservan. Los nuevos destinatarios reciben una notificación en la bandeja.
- Las tareas y los clientes/obras se pueden eliminar con confirmación. Para evitar asociaciones rotas, primero hay que eliminar las tareas vinculadas a un cliente/obra.
- La bandeja de notificaciones es personal para el usuario seleccionado, muestra quién asignó cada tarea y se actualiza periódicamente mientras la app está abierta.
- Los recordatorios de las 08:00 incluyen tanto tareas pendientes como tareas en proceso.
