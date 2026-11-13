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

1. Crea la tabla ejecutando [`schema.sql`](./schema.sql) en la base Azure SQL.
2. Copia `.env.example` a `.env` y sustituye los placeholders `AZURE_SQL_SERVER`, `AZURE_SQL_DATABASE`, `AZURE_SQL_USER` y `AZURE_SQL_PASSWORD` por credenciales reales. No publiques `.env`.
3. La acción visible **Completar** pide confirmación antes de marcar la tarea como terminada. Luego, el servidor conserva el cambio local e intenta registrarlo en `dbo.CompletedTasks`. Si Azure no está disponible, el cliente informa que la sincronización está pendiente y el servidor reintenta cada cinco minutos.

La autenticación por selección de usuario es **simulada** y sirve únicamente para una demostración controlada. Antes de publicar la app, reemplázala por autenticación real (por ejemplo, Microsoft Entra ID), valida permisos en el servidor y usa almacenamiento compartido y persistente para despliegues con varias instancias.

## Recordatorios

El servidor agrupa cada día a las 08:00 las tareas abiertas por destinatario y escribe un recordatorio personalizado en su log. Es una simulación: no se envían notificaciones push, correo ni SMS. `APP_TIMEZONE` controla la zona horaria del cron y por defecto es `America/Argentina/Buenos_Aires`. Para notificaciones reales, integra un proveedor de push/correo en `sendDailyReminders`.

## Experiencia móvil

- Diseño responsive con controles táctiles de al menos 48 px, áreas seguras de pantalla y transiciones que respetan `prefers-reduced-motion`.
- La sesión simulada persiste en `localStorage` hasta cerrar sesión; las tareas y credenciales no se almacenan en el navegador.
- La vista personal es la inicial; “Todas” muestra las tareas de todo el equipo. Las pestañas separan pendientes y completadas; las completadas indican quién y cuándo las terminó.
- Completar una tarea pide confirmación, la retira inmediatamente del tablero y sincroniza con el servidor en segundo plano.
