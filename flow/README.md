# DIEC flow

Aplicación web adaptable a móviles para organizar tareas del equipo. Azure SQL es la única fuente de verdad de tareas, clientes/obras y notificaciones. La aplicación requiere una conexión SQL, PIN individual para cada usuario y SMTP configurado; no inicia con valores de ejemplo ni usa almacenamiento local como alternativa.

## Requisitos

- Node.js 20 o superior.
- Azure SQL con el esquema de [`schema.sql`](./schema.sql).
- Variables `AZURE_SQL_*`, seis variables `USER_PIN_*` y credenciales SMTP.
- Correos de trabajo cargados en `dbo.Usuarios.Email` para recibir recordatorios.

## Configuración

Para desarrollo local:

```sh
cd flow
npm ci
cp .env.example .env
# Completa todos los valores de .env sin guardar ese archivo en Git.
npm start
```

En App Service configura los mismos valores en **Settings → Environment variables**. Los PIN deben ser seis valores individuales de exactamente cuatro dígitos; no uses los ejemplos de `.env.example`.

| Usuario | Variable de App Setting |
| --- | --- |
| Pamela Pérez | `USER_PIN_PAMELA_PEREZ` |
| Nataniel Goyechea | `USER_PIN_NATANIEL_GOYECHEA` |
| David Maglione | `USER_PIN_DAVID_MAGLIONE` |
| Alen García | `USER_PIN_ALEN_GARCIA` |
| Roberto Martin | `USER_PIN_ROBERTO_MARTIN` |
| DIEC SAS | `USER_PIN_DIEC_SAS` |

El servidor compara el PIN en tiempo constante, limita intentos por IP/usuario y abre una sesión de servidor de 12 horas en una cookie `HttpOnly`, `SameSite=Strict` y `Secure` bajo HTTPS. Todas las rutas de API salvo el listado público de nombres y el inicio de sesión requieren esa sesión. La limitación de intentos y sesiones viven en memoria: mantén App Service en una sola instancia; reiniciar el proceso cierra las sesiones y reinicia el contador de intentos. Un PIN de cuatro dígitos es una protección básica, no sustituye MFA para datos sensibles.

## Azure SQL y datos existentes

1. Respaldá la base de datos. Ejecuta [`schema.sql`](./schema.sql) una vez: es compatible con las tablas de DIEC flow existentes, agrega usuarios, correo y ledger de recordatorios, y no elimina datos.
2. Completa los correos de cada empleado:

   ```sql
   UPDATE dbo.Usuarios SET Email = N'pamela@empresa.example' WHERE Name = N'Pamela Pérez';
   ```

   Repite con las direcciones corporativas reales. No dejes correos ficticios.
3. Configura `AZURE_SQL_SERVER`, `AZURE_SQL_DATABASE`, `AZURE_SQL_USER` y `AZURE_SQL_PASSWORD`, además de los PIN y valores SMTP. App Service cifra App Settings en reposo; restringe quién puede leerlos. No uses las credenciales de administrador SQL para la aplicación.
4. Si necesitas importar registros activos de la antigua carpeta local `flow/data/` a una base nueva y vacía, configura temporalmente las variables SQL y ejecuta:

   ```sh
   npm run migrate:json
   ```

   El importador inserta clientes/obras, tareas y notificaciones activas en una transacción, rechaza una base con datos existentes y nunca borra ni modifica los JSON originales. Las filas que ya tenían estado `deleted` son tombstones de eliminación, no tareas activas. Verifica los conteos de SQL y conserva los archivos fuente hasta completar y respaldar la importación.
5. Si la base ya contiene tareas válidas, el importador se detiene intencionalmente: no intentes importar duplicados. Confirma los datos en Azure SQL antes de publicar el servidor actualizado.

El servidor no lee ni escribe archivos JSON. Todas las operaciones CRUD de tareas, clientes/obras y notificaciones ocurren en SQL; creación de tareas y notificaciones asociadas se confirman en una misma transacción. Borrar una tarea elimina también sus avisos relacionados.

## Correo recordatorio

Configura `SMTP_HOST`, `SMTP_PORT` (587 para STARTTLS o 465 para TLS implícito), `SMTP_USER`, `SMTP_PASS` y, opcionalmente, `SMTP_FROM`. El proceso consulta tareas `Pendiente` y `En proceso`, agrupa el resumen por destinatario y envía un correo individual a `dbo.Usuarios.Email` a las 08:00 de `APP_TIMEZONE`. Los envíos se registran en `dbo.RecordatoriosEmail` para evitar duplicados y permitir reintentos controlados si falla SMTP. Mantén una sola instancia para que el cron no duplique trabajo.

Las notificaciones de asignación son avisos in-app consultados mientras la app está abierta; no son push móviles ni correo instantáneo.

## PWA móvil

- `manifest.webmanifest`, iconos PNG y `sw.js` permiten instalación desde el navegador por HTTPS.
- El Service Worker almacena únicamente el shell estático (HTML, CSS, JS, manifest e iconos). Excluye todas las rutas `/api/` y no cachea respuestas personales ni credenciales.
- Android: abrir la URL en Chrome y elegir **Instalar aplicación** o **Añadir a pantalla de inicio**. iPhone: abrir en Safari y elegir **Compartir → Añadir a pantalla de inicio**.
- La caché estática no hace funcionar operaciones offline: las tareas necesitan Azure SQL y conexión de red.

## Producción en App Service

- Usa Linux y un runtime Node LTS soportado, configura `npm start`, `PORT` y las App Settings anteriores.
- Activa **HTTPS Only**, mínimo TLS 1.2 y Always On. Usa al menos una instancia; no escales horizontalmente sin migrar sesiones y limitación de intentos a almacenamiento compartido.
- Despliega solo los archivos de `flow/`, `package.json` y `package-lock.json`; excluye `.env`, `data/` y `node_modules/`.
- Si existe un dominio corporativo, valida DNS, asocia un certificado administrado válido y prueba renovación HTTPS. El hostname `*.azurewebsites.net` también tiene certificado Azure válido. HTTPS no garantiza reputación de dominio en Chrome Safe Browsing.
- Restringe red de SQL a App Service (idealmente Private Endpoint/VNet) y habilita backup, auditoría y alertas.

Antes de habilitar datos reales, prueba login con PIN válido e inválido, bloqueo de intentos, acceso API sin sesión, creación/edición/eliminación y persistencia después de reiniciar App Service, entrega SMTP por usuario, y la instalación Android/iOS. Confirma que el navegador no cachee solicitudes `/api/` y que certificado, cadena y redirección HTTPS sean válidos.
