import "dotenv/config";
import { createServer } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cron from "node-cron";
import nodemailer from "nodemailer";
import sql from "mssql";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const USERS = [
  "Pamela Pérez",
  "Nataniel Goyechea",
  "David Maglione",
  "Alen García",
  "Roberto Martin",
  "DIEC SAS",
];
const TASK_STATUS_LABELS = {
  pending: "Pendiente",
  in_progress: "En proceso",
  completed: "Completada",
};
const LABEL_TASK_STATUSES = Object.fromEntries(
  Object.entries(TASK_STATUS_LABELS).map(([key, value]) => [value, key]),
);
const PORT = Number(process.env.PORT || 3000);
const TIMEZONE = process.env.APP_TIMEZONE || "America/Argentina/Buenos_Aires";
const SESSION_COOKIE = "diec_flow_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_IP_LIMIT = 12;
const LOGIN_USER_LIMIT = 5;
const LOGIN_ATTEMPTS = new Map();
const SESSIONS = new Map();
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

function pinEnvironmentKey(name) {
  const normalized = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return `USER_PIN_${normalized.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "")}`;
}

function validateEnvironment() {
  const sqlSettings = ["AZURE_SQL_SERVER", "AZURE_SQL_DATABASE", "AZURE_SQL_USER", "AZURE_SQL_PASSWORD"];
  const missingSql = sqlSettings.filter((key) => !process.env[key] || process.env[key].startsWith("your-"));
  if (missingSql.length) throw new Error(`Faltan variables Azure SQL: ${missingSql.join(", ")}.`);
  const pinKeys = USERS.map(pinEnvironmentKey);
  const missingPins = pinKeys.filter((key) => !/^\d{4}$/.test(process.env[key] || ""));
  if (missingPins.length) throw new Error(`Configura cada PIN de 4 dígitos en App Settings: ${missingPins.join(", ")}.`);
  if (new Set(pinKeys.map((key) => process.env[key])).size !== pinKeys.length) {
    throw new Error("Cada usuario debe tener un PIN distinto.");
  }
  const missingSmtp = ["SMTP_HOST", "SMTP_USER", "SMTP_PASS"]
    .filter((key) => !process.env[key] || process.env[key].startsWith("your-"));
  if (missingSmtp.length) throw new Error(`Faltan variables SMTP: ${missingSmtp.join(", ")}.`);
}

let sqlPool;
async function getSqlPool() {
  if (!sqlPool) {
    sqlPool = new sql.ConnectionPool({
      server: process.env.AZURE_SQL_SERVER,
      database: process.env.AZURE_SQL_DATABASE,
      user: process.env.AZURE_SQL_USER,
      password: process.env.AZURE_SQL_PASSWORD,
      options: { encrypt: true, trustServerCertificate: false },
      pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
      connectionTimeout: 10000,
      requestTimeout: 15000,
    }).connect().catch((error) => {
      sqlPool = undefined;
      throw error;
    });
  }
  return sqlPool;
}

function isoDateTime(value) {
  return value ? new Date(value).toISOString() : null;
}

function mapClientWork(row) {
  return {
    id: row.ClientWorkId,
    name: row.Name,
    description: row.Description || "",
    createdAt: isoDateTime(row.CreatedAt),
  };
}

function mapTask(row) {
  let recipients;
  try {
    recipients = JSON.parse(row.Recipients);
  } catch {
    throw new Error(`La lista de destinatarios de la tarea ${row.TaskId} no es JSON válido.`);
  }
  if (!Array.isArray(recipients) || recipients.some((name) => typeof name !== "string")) {
    throw new Error(`La lista de destinatarios de la tarea ${row.TaskId} tiene un formato inválido.`);
  }
  return {
    id: row.TaskId,
    description: row.Description,
    recipients,
    createdBy: row.CreatedBy || null,
    createdAt: isoDateTime(row.CreatedAt),
    dueDate: row.DueDate ? new Date(row.DueDate).toISOString().slice(0, 10) : null,
    clientWorkId: row.ClientWorkId,
    clientWorkName: row.ClientWorkName || null,
    status: LABEL_TASK_STATUSES[row.Estado],
    completedAt: isoDateTime(row.CompletedAt),
    completedBy: row.CompletedBy || null,
  };
}

function mapNotification(row) {
  return {
    id: row.NotificationId,
    taskId: row.TaskId,
    recipient: row.Recipient,
    createdBy: row.CreatedBy,
    description: row.Description,
    clientWorkName: row.ClientWorkName || null,
    createdAt: isoDateTime(row.CreatedAt),
    readAt: isoDateTime(row.ReadAt),
  };
}

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    ...headers,
  });
  response.end(JSON.stringify(value));
}

async function readJsonBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1_000_000) throw Object.assign(new Error("La solicitud es demasiado grande."), { status: 413 });
  }
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    throw Object.assign(new Error("El cuerpo de la solicitud debe ser JSON válido."), { status: 400 });
  }
}

function isValidDueDate(value) {
  if (value === null || value === undefined || value === "") return true;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function isUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function requestIp(request) {
  return request.headers["x-arr-clientip"]
    || request.socket.remoteAddress
    || "unknown";
}

function loginLimit(ip, user) {
  const now = Date.now();
  for (const [key, bucket] of LOGIN_ATTEMPTS) {
    if (bucket.expiresAt <= now) LOGIN_ATTEMPTS.delete(key);
  }
  const ipBucket = LOGIN_ATTEMPTS.get(`ip:${ip}`);
  const userBucket = LOGIN_ATTEMPTS.get(`user:${ip}:${user}`);
  if ((ipBucket?.count || 0) >= LOGIN_IP_LIMIT || (userBucket?.count || 0) >= LOGIN_USER_LIMIT) return false;
  return true;
}

function recordLoginFailure(ip, user) {
  const expiresAt = Date.now() + LOGIN_WINDOW_MS;
  for (const key of [`ip:${ip}`, `user:${ip}:${user}`]) {
    const bucket = LOGIN_ATTEMPTS.get(key);
    LOGIN_ATTEMPTS.set(key, { count: (bucket?.count || 0) + 1, expiresAt });
  }
}

function clearLoginFailures(ip, user) {
  LOGIN_ATTEMPTS.delete(`ip:${ip}`);
  LOGIN_ATTEMPTS.delete(`user:${ip}:${user}`);
}

function readCookie(request, name) {
  const cookies = request.headers.cookie || "";
  for (const entry of cookies.split(";")) {
    const [key, ...value] = entry.trim().split("=");
    if (key === name) {
      try {
        return decodeURIComponent(value.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function secureRequest(request) {
  return request.socket.encrypted || request.headers["x-forwarded-proto"]?.split(",")[0].trim() === "https";
}

function transportSecurityHeaders(request) {
  return secureRequest(request) ? { "Strict-Transport-Security": "max-age=31536000" } : {};
}

function sessionCookie(token, request) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secureRequest(request) ? "; Secure" : ""}`;
}

function getSession(request) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const session = SESSIONS.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    SESSIONS.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return { token, ...session };
}

function originIsSame(request) {
  const origin = request.headers.origin;
  if (!origin) return false;
  const scheme = request.headers["x-forwarded-proto"]?.split(",")[0].trim()
    || (request.socket.encrypted ? "https" : "http");
  const host = request.headers["x-forwarded-host"]?.split(",")[0].trim() || request.headers.host;
  return origin === `${scheme}://${host}`;
}

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function createSmtpTransport() {
  const port = Number(process.env.SMTP_PORT || 587);
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    requireTLS: port !== 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

const smtpTransport = createSmtpTransport();

async function handleLogin(request, response) {
  const body = await readJsonBody(request);
  const name = typeof body.name === "string" ? body.name : "";
  const pin = typeof body.pin === "string" ? body.pin : "";
  if (!USERS.includes(name) || !/^\d{4}$/.test(pin)) {
    return sendJson(response, 400, { error: "Seleccioná un usuario e ingresá un PIN de 4 dígitos." });
  }
  const ip = requestIp(request);
  if (!loginLimit(ip, name)) {
    return sendJson(response, 429, { error: "Demasiados intentos. Esperá 15 minutos antes de volver a probar." });
  }
  const expected = Buffer.from(process.env[pinEnvironmentKey(name)]);
  const provided = Buffer.from(pin);
  const valid = expected.length === provided.length && timingSafeEqual(expected, provided);
  if (!valid) {
    recordLoginFailure(ip, name);
    return sendJson(response, 401, { error: "El PIN no es correcto." });
  }
  clearLoginFailures(ip, name);
  for (const [token, activeSession] of SESSIONS) {
    if (activeSession.expiresAt <= Date.now()) SESSIONS.delete(token);
  }
  const token = randomBytes(32).toString("base64url");
  SESSIONS.set(token, { user: name, expiresAt: Date.now() + SESSION_TTL_MS });
  return sendJson(response, 200, { user: name }, { "Set-Cookie": sessionCookie(token, request) });
}

async function handleApi(request, response, url, session) {
  if (request.method === "GET" && url.pathname === "/api/users") {
    const result = await (await getSqlPool()).request().query("SELECT Name FROM dbo.Usuarios ORDER BY Name;");
    return sendJson(response, 200, { users: result.recordset.map((row) => row.Name) });
  }

  if (request.method === "POST" && url.pathname === "/api/session/login") {
    return handleLogin(request, response);
  }

  if (request.method === "GET" && url.pathname === "/api/session") {
    if (!session) return sendJson(response, 401, { error: "La sesión venció. Volvé a ingresar." });
    return sendJson(response, 200, { user: session.user });
  }

  if (request.method === "POST" && url.pathname === "/api/session/logout") {
    if (session) SESSIONS.delete(session.token);
    return sendJson(response, 200, { loggedOut: true }, {
      "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureRequest(request) ? "; Secure" : ""}`,
    });
  }

  if (!session) return sendJson(response, 401, { error: "La sesión venció. Volvé a ingresar." });
  const pool = await getSqlPool();

  if (request.method === "GET" && url.pathname === "/api/client-works") {
    const result = await pool.request().query(`
      SELECT ClientWorkId, Name, Description, CreatedAt
      FROM dbo.Clientes_Obras
      ORDER BY Name;
    `);
    return sendJson(response, 200, { clientWorks: result.recordset.map(mapClientWork) });
  }

  if (request.method === "GET" && url.pathname === "/api/notifications") {
    const user = url.searchParams.get("user");
    if (user !== session.user) return sendJson(response, 403, { error: "No podés consultar las notificaciones de otro usuario." });
    const result = await pool.request()
      .input("recipient", sql.NVarChar(100), session.user)
      .query(`
        SELECT NotificationId, TaskId, Recipient, CreatedBy, Description, ClientWorkName, CreatedAt, ReadAt
        FROM dbo.Notificaciones
        WHERE Recipient = @recipient
        ORDER BY CreatedAt DESC;
      `);
    return sendJson(response, 200, { notifications: result.recordset.map(mapNotification) });
  }

  const notificationReadMatch = url.pathname.match(/^\/api\/notifications\/([0-9a-f-]+)\/read$/i);
  if (request.method === "PATCH" && notificationReadMatch) {
    const result = await pool.request()
      .input("notificationId", sql.UniqueIdentifier, notificationReadMatch[1])
      .input("recipient", sql.NVarChar(100), session.user)
      .query(`
        UPDATE dbo.Notificaciones
        SET ReadAt = COALESCE(ReadAt, SYSUTCDATETIME())
        OUTPUT inserted.NotificationId, inserted.TaskId, inserted.Recipient,
               inserted.CreatedBy, inserted.Description, inserted.ClientWorkName,
               inserted.CreatedAt, inserted.ReadAt
        WHERE NotificationId = @notificationId AND Recipient = @recipient;
      `);
    if (!result.recordset[0]) return sendJson(response, 404, { error: "No se encontró la notificación." });
    return sendJson(response, 200, { notification: mapNotification(result.recordset[0]) });
  }

  if (request.method === "POST" && url.pathname === "/api/client-works") {
    const body = await readJsonBody(request);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    if (!name || name.length > 150) {
      return sendJson(response, 400, { error: "El nombre es obligatorio y debe tener hasta 150 caracteres." });
    }
    if (description.length > 500) return sendJson(response, 400, { error: "La descripción debe tener hasta 500 caracteres." });
    const transaction = new sql.Transaction(pool);
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    try {
      const requestInTransaction = new sql.Request(transaction);
      const existing = await requestInTransaction
        .input("name", sql.NVarChar(150), name)
        .query("SELECT TOP (1) ClientWorkId FROM dbo.Clientes_Obras WITH (UPDLOCK, HOLDLOCK) WHERE Name = @name;");
      if (existing.recordset.length) {
        await transaction.rollback();
        return sendJson(response, 409, { error: "Ya existe un cliente / obra con ese nombre." });
      }
      const id = randomUUID();
      const inserted = await new sql.Request(transaction)
        .input("clientWorkId", sql.UniqueIdentifier, id)
        .input("name", sql.NVarChar(150), name)
        .input("description", sql.NVarChar(500), description || null)
        .query(`
          INSERT INTO dbo.Clientes_Obras (ClientWorkId, Name, Description, CreatedAt)
          OUTPUT inserted.ClientWorkId, inserted.Name, inserted.Description, inserted.CreatedAt
          VALUES (@clientWorkId, @name, @description, SYSUTCDATETIME());
        `);
      await transaction.commit();
      return sendJson(response, 201, { clientWork: mapClientWork(inserted.recordset[0]) });
    } catch (error) {
      if (transaction._aborted !== true) await transaction.rollback();
      if (error.number === 2601 || error.number === 2627) {
        return sendJson(response, 409, { error: "Ya existe un cliente / obra con ese nombre." });
      }
      throw error;
    }
  }

  const clientWorkDeletionMatch = url.pathname.match(/^\/api\/client-works\/([0-9a-f-]+)$/i);
  if (request.method === "DELETE" && clientWorkDeletionMatch) {
    const clientWorkId = clientWorkDeletionMatch[1];
    if (!isUuid(clientWorkId)) return sendJson(response, 400, { error: "El identificador del cliente / obra no es válido." });
    const transaction = new sql.Transaction(pool);
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    try {
      const requestInTransaction = new sql.Request(transaction)
        .input("clientWorkId", sql.UniqueIdentifier, clientWorkId);
      const tasks = await requestInTransaction.query("SELECT TOP (1) TaskId FROM dbo.Tareas WITH (UPDLOCK, HOLDLOCK) WHERE ClientWorkId = @clientWorkId;");
      if (tasks.recordset.length) {
        await transaction.rollback();
        return sendJson(response, 409, { error: "Primero eliminá las tareas asociadas a este cliente / obra." });
      }
      const deleted = await new sql.Request(transaction)
        .input("clientWorkId", sql.UniqueIdentifier, clientWorkId)
        .query("DELETE FROM dbo.Clientes_Obras OUTPUT deleted.ClientWorkId WHERE ClientWorkId = @clientWorkId;");
      await transaction.commit();
      if (!deleted.recordset.length) return sendJson(response, 404, { error: "No se encontró el cliente / obra." });
      return sendJson(response, 200, { deleted: true });
    } catch (error) {
      if (transaction._aborted !== true) await transaction.rollback();
      throw error;
    }
  }

  if (request.method === "GET" && url.pathname === "/api/tasks") {
    const view = url.searchParams.get("view") || "personal";
    const status = url.searchParams.get("status") || "active";
    const requestedUser = url.searchParams.get("user");
    if (!["personal", "global"].includes(view) || !["active", "completed"].includes(status)) {
      return sendJson(response, 400, { error: "La vista o el estado seleccionados no son válidos." });
    }
    if (view === "personal" && requestedUser !== session.user) {
      return sendJson(response, 403, { error: "No podés consultar las tareas personales de otro usuario." });
    }
    const result = await pool.request()
      .input("completed", sql.Bit, status === "completed")
      .input("globalView", sql.Bit, view === "global")
      .input("user", sql.NVarChar(100), session.user)
      .query(`
        SELECT t.TaskId, t.Description, t.Recipients, t.CreatedBy, t.CreatedAt,
               t.DueDate, t.ClientWorkId, c.Name AS ClientWorkName,
               t.Estado, t.CompletedAt, t.CompletedBy
        FROM dbo.Tareas AS t
        LEFT JOIN dbo.Clientes_Obras AS c ON c.ClientWorkId = t.ClientWorkId
        WHERE (
          (@completed = 1 AND t.Estado = N'Completada')
          OR (@completed = 0 AND t.Estado IN (N'Pendiente', N'En proceso'))
        )
        AND (
          @globalView = 1
          OR EXISTS (
            SELECT 1 FROM OPENJSON(t.Recipients) AS recipient
            WHERE recipient.[value] = @user
          )
        )
        ORDER BY CASE WHEN @completed = 1 THEN t.CompletedAt END DESC, t.CreatedAt DESC;
      `);
    return sendJson(response, 200, { tasks: result.recordset.map(mapTask) });
  }

  if (request.method === "POST" && url.pathname === "/api/tasks") {
    const body = await readJsonBody(request);
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const recipients = Array.isArray(body.recipients) ? [...new Set(body.recipients)] : [];
    if (!description || description.length > 1000) {
      return sendJson(response, 400, { error: "La descripción es obligatoria y debe tener hasta 1000 caracteres." });
    }
    if (!recipients.length || recipients.some((name) => !USERS.includes(name))) {
      return sendJson(response, 400, { error: "Elegí al menos un destinatario válido." });
    }
    if (!isValidDueDate(body.dueDate)) return sendJson(response, 400, { error: "La fecha de vencimiento no es válida." });
    const clientWorkId = body.clientWorkId || null;
    if (clientWorkId && !isUuid(clientWorkId)) return sendJson(response, 400, { error: "El cliente / obra seleccionado no es válido." });
    const id = randomUUID();
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      const inserted = await new sql.Request(transaction)
        .input("taskId", sql.UniqueIdentifier, id)
        .input("description", sql.NVarChar(1000), description)
        .input("recipients", sql.NVarChar(sql.MAX), JSON.stringify(recipients))
        .input("createdBy", sql.NVarChar(100), session.user)
        .input("clientWorkId", sql.UniqueIdentifier, clientWorkId)
        .input("dueDate", sql.Date, body.dueDate ? new Date(`${body.dueDate}T00:00:00.000Z`) : null)
        .query(`
          INSERT INTO dbo.Tareas
            (TaskId, Description, Recipients, CreatedBy, CreatedAt, ClientWorkId, Estado, DueDate)
          OUTPUT inserted.TaskId, inserted.Description, inserted.Recipients, inserted.CreatedBy,
                 inserted.CreatedAt, inserted.DueDate, inserted.ClientWorkId,
                 CAST(NULL AS NVARCHAR(150)) AS ClientWorkName, inserted.Estado,
                 inserted.CompletedAt, inserted.CompletedBy
          VALUES (@taskId, @description, @recipients, @createdBy, SYSUTCDATETIME(),
                  @clientWorkId, N'Pendiente', @dueDate);
        `);
      const clientWorkName = await insertTaskNotifications(transaction, {
        taskId: id,
        recipients,
        createdBy: session.user,
        description,
        clientWorkId,
      });
      await transaction.commit();
      const task = mapTask(inserted.recordset[0]);
      task.clientWorkName = clientWorkName;
      return sendJson(response, 201, { task });
    } catch (error) {
      if (transaction._aborted !== true) await transaction.rollback();
      if (error.number === 547) return sendJson(response, 400, { error: "El cliente / obra seleccionado no existe." });
      throw error;
    }
  }

  const taskIdMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)$/i);
  if (taskIdMatch && !isUuid(taskIdMatch[1])) return sendJson(response, 400, { error: "El identificador de tarea no es válido." });

  if (request.method === "PATCH" && taskIdMatch) {
    const body = await readJsonBody(request);
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const recipients = Array.isArray(body.recipients) ? [...new Set(body.recipients)] : [];
    if (!description || description.length > 1000) {
      return sendJson(response, 400, { error: "La descripción es obligatoria y debe tener hasta 1000 caracteres." });
    }
    if (!recipients.length || recipients.some((name) => !USERS.includes(name))) {
      return sendJson(response, 400, { error: "Elegí al menos un destinatario válido." });
    }
    if (!isValidDueDate(body.dueDate)) return sendJson(response, 400, { error: "La fecha de vencimiento no es válida." });
    const clientWorkId = body.clientWorkId || null;
    if (clientWorkId && !isUuid(clientWorkId)) return sendJson(response, 400, { error: "El cliente / obra seleccionado no es válido." });

    const transaction = new sql.Transaction(pool);
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    try {
      const current = await new sql.Request(transaction)
        .input("taskId", sql.UniqueIdentifier, taskIdMatch[1])
        .query("SELECT Recipients, Estado FROM dbo.Tareas WITH (UPDLOCK, HOLDLOCK) WHERE TaskId = @taskId;");
      if (!current.recordset[0]) {
        await transaction.rollback();
        return sendJson(response, 404, { error: "No se encontró la tarea." });
      }
      if (!["Pendiente", "En proceso"].includes(current.recordset[0].Estado)) {
        await transaction.rollback();
        return sendJson(response, 409, { error: "Solo se pueden editar tareas Pendientes o En proceso." });
      }
      const oldRecipients = JSON.parse(current.recordset[0].Recipients);
      const addedRecipients = recipients.filter((recipient) => !oldRecipients.includes(recipient));
      const updated = await new sql.Request(transaction)
        .input("taskId", sql.UniqueIdentifier, taskIdMatch[1])
        .input("description", sql.NVarChar(1000), description)
        .input("recipients", sql.NVarChar(sql.MAX), JSON.stringify(recipients))
        .input("clientWorkId", sql.UniqueIdentifier, clientWorkId)
        .input("dueDate", sql.Date, body.dueDate ? new Date(`${body.dueDate}T00:00:00.000Z`) : null)
        .query(`
          UPDATE dbo.Tareas
          SET Description = @description, Recipients = @recipients,
              ClientWorkId = @clientWorkId, DueDate = @dueDate
          OUTPUT inserted.TaskId, inserted.Description, inserted.Recipients, inserted.CreatedBy,
                 inserted.CreatedAt, inserted.DueDate, inserted.ClientWorkId,
                 CAST(NULL AS NVARCHAR(150)) AS ClientWorkName, inserted.Estado,
                 inserted.CompletedAt, inserted.CompletedBy
          WHERE TaskId = @taskId;
        `);
      const clientWorkName = await insertTaskNotifications(transaction, {
        taskId: taskIdMatch[1],
        recipients: addedRecipients,
        createdBy: session.user,
        description,
        clientWorkId,
      });
      await transaction.commit();
      const task = mapTask(updated.recordset[0]);
      task.clientWorkName = clientWorkName;
      return sendJson(response, 200, { task });
    } catch (error) {
      if (transaction._aborted !== true) await transaction.rollback();
      if (error.number === 547) return sendJson(response, 400, { error: "El cliente / obra seleccionado no existe." });
      throw error;
    }
  }

  if (request.method === "DELETE" && taskIdMatch) {
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      await new sql.Request(transaction)
        .input("taskId", sql.UniqueIdentifier, taskIdMatch[1])
        .query("DELETE FROM dbo.Notificaciones WHERE TaskId = @taskId;");
      const deleted = await new sql.Request(transaction)
        .input("taskId", sql.UniqueIdentifier, taskIdMatch[1])
        .query("DELETE FROM dbo.Tareas OUTPUT deleted.TaskId WHERE TaskId = @taskId;");
      if (!deleted.recordset.length) {
        await transaction.rollback();
        return sendJson(response, 404, { error: "No se encontró la tarea." });
      }
      await transaction.commit();
      return sendJson(response, 200, { deleted: true });
    } catch (error) {
      if (transaction._aborted !== true) await transaction.rollback();
      throw error;
    }
  }

  const statusMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/status$/i);
  if (request.method === "PATCH" && statusMatch) {
    if (!isUuid(statusMatch[1])) return sendJson(response, 400, { error: "El identificador de tarea no es válido." });
    const body = await readJsonBody(request);
    if (!["pending", "in_progress"].includes(body.status)) {
      return sendJson(response, 400, { error: "El estado debe ser Pendiente o En proceso." });
    }
    const result = await pool.request()
      .input("taskId", sql.UniqueIdentifier, statusMatch[1])
      .input("status", sql.NVarChar(20), TASK_STATUS_LABELS[body.status])
      .query(`
        UPDATE dbo.Tareas
        SET Estado = @status, CompletedAt = NULL, CompletedBy = NULL
        OUTPUT inserted.TaskId, inserted.Description, inserted.Recipients, inserted.CreatedBy,
               inserted.CreatedAt, inserted.DueDate, inserted.ClientWorkId,
               CAST(NULL AS NVARCHAR(150)) AS ClientWorkName, inserted.Estado,
               inserted.CompletedAt, inserted.CompletedBy
        WHERE TaskId = @taskId
          AND (
            (@status = N'Pendiente' AND Estado IN (N'Pendiente', N'En proceso', N'Completada'))
            OR (@status = N'En proceso' AND Estado IN (N'Pendiente', N'En proceso'))
          );
      `);
    if (!result.recordset[0]) return sendJson(response, 404, { error: "No se encontró la tarea." });
    const task = mapTask(result.recordset[0]);
    if (task.clientWorkId) {
      const client = await pool.request()
        .input("clientWorkId", sql.UniqueIdentifier, task.clientWorkId)
        .query("SELECT Name FROM dbo.Clientes_Obras WHERE ClientWorkId = @clientWorkId;");
      task.clientWorkName = client.recordset[0]?.Name || null;
    }
    return sendJson(response, 200, { task });
  }

  const completionMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/complete$/i);
  if (request.method === "PATCH" && completionMatch) {
    if (!isUuid(completionMatch[1])) return sendJson(response, 400, { error: "El identificador de tarea no es válido." });
    const result = await pool.request()
      .input("taskId", sql.UniqueIdentifier, completionMatch[1])
      .input("completedBy", sql.NVarChar(100), session.user)
      .query(`
        UPDATE dbo.Tareas
        SET Estado = N'Completada', CompletedAt = SYSUTCDATETIME(), CompletedBy = @completedBy
        OUTPUT inserted.TaskId, inserted.Description, inserted.Recipients, inserted.CreatedBy,
               inserted.CreatedAt, inserted.DueDate, inserted.ClientWorkId,
               CAST(NULL AS NVARCHAR(150)) AS ClientWorkName, inserted.Estado,
               inserted.CompletedAt, inserted.CompletedBy
        WHERE TaskId = @taskId AND Estado IN (N'Pendiente', N'En proceso');
      `);
    if (!result.recordset[0]) return sendJson(response, 404, { error: "No se encontró una tarea activa para completar." });
    return sendJson(response, 200, { task: mapTask(result.recordset[0]) });
  }

  return sendJson(response, 404, { error: "Ruta no encontrada." });
}

async function insertTaskNotifications(transaction, task) {
  const clientWorkResult = task.clientWorkId
    ? await new sql.Request(transaction)
      .input("clientWorkId", sql.UniqueIdentifier, task.clientWorkId)
      .query("SELECT Name FROM dbo.Clientes_Obras WHERE ClientWorkId = @clientWorkId;")
    : null;
  const clientWorkName = clientWorkResult?.recordset[0]?.Name || null;
  if (!task.recipients.length) return clientWorkName;
  for (const recipient of task.recipients) {
    await new sql.Request(transaction)
      .input("notificationId", sql.UniqueIdentifier, randomUUID())
      .input("taskId", sql.UniqueIdentifier, task.taskId)
      .input("recipient", sql.NVarChar(100), recipient)
      .input("createdBy", sql.NVarChar(100), task.createdBy)
      .input("description", sql.NVarChar(1000), task.description)
      .input("clientWorkName", sql.NVarChar(150), clientWorkName)
      .query(`
        INSERT INTO dbo.Notificaciones
          (NotificationId, TaskId, Recipient, CreatedBy, Description, ClientWorkName, CreatedAt)
        VALUES
          (@notificationId, @taskId, @recipient, @createdBy, @description, @clientWorkName, SYSUTCDATETIME());
      `);
  }
  return clientWorkName;
}

async function claimEmailReminder(userId, reminderDate) {
  const transaction = new sql.Transaction(await getSqlPool());
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const existing = await new sql.Request(transaction)
      .input("userId", sql.Int, userId)
      .input("reminderDate", sql.Date, new Date(`${reminderDate}T00:00:00.000Z`))
      .query(`
        SELECT Status, AttemptedAt
        FROM dbo.RecordatoriosEmail WITH (UPDLOCK, HOLDLOCK)
        WHERE UserId = @userId AND ReminderDate = @reminderDate;
      `);
    const row = existing.recordset[0];
    const tooSoon = ["Fallido", "Enviando"].includes(row?.Status)
      && Date.now() - new Date(row.AttemptedAt).getTime() < 30 * 60 * 1000;
    if (row?.Status === "Enviado" || row?.Status === "Enviando" || tooSoon) {
      await transaction.commit();
      return false;
    }
    await new sql.Request(transaction)
      .input("userId", sql.Int, userId)
      .input("reminderDate", sql.Date, new Date(`${reminderDate}T00:00:00.000Z`))
      .query(`
        IF EXISTS (SELECT 1 FROM dbo.RecordatoriosEmail WHERE UserId = @userId AND ReminderDate = @reminderDate)
          UPDATE dbo.RecordatoriosEmail
          SET Status = N'Enviando', AttemptedAt = SYSUTCDATETIME(), LastError = NULL
          WHERE UserId = @userId AND ReminderDate = @reminderDate;
        ELSE
          INSERT INTO dbo.RecordatoriosEmail (UserId, ReminderDate, Status, AttemptedAt)
          VALUES (@userId, @reminderDate, N'Enviando', SYSUTCDATETIME());
      `);
    await transaction.commit();
    return true;
  } catch (error) {
    if (transaction._aborted !== true) await transaction.rollback();
    throw error;
  }
}

async function updateReminderStatus(userId, reminderDate, status, errorMessage = null) {
  await (await getSqlPool()).request()
    .input("userId", sql.Int, userId)
    .input("reminderDate", sql.Date, new Date(`${reminderDate}T00:00:00.000Z`))
    .input("status", sql.NVarChar(20), status)
    .input("lastError", sql.NVarChar(1000), errorMessage)
    .query(`
      UPDATE dbo.RecordatoriosEmail
      SET Status = @status, LastError = @lastError,
          SentAt = CASE WHEN @status = N'Enviado' THEN SYSUTCDATETIME() ELSE NULL END
      WHERE UserId = @userId AND ReminderDate = @reminderDate;
    `);
}

async function sendDailyReminders() {
  const localHour = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    hour: "2-digit",
    hourCycle: "h23",
  }).format(new Date()));
  if (localHour !== 8) return;
  const dateParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const date = Object.fromEntries(dateParts.map(({ type, value }) => [type, value]));
  const reminderDate = `${date.year}-${date.month}-${date.day}`;
  const result = await (await getSqlPool()).request().query(`
    SELECT u.UserId, u.Name, u.Email, t.TaskId, t.Description, t.Estado, t.DueDate, c.Name AS ClientWorkName
    FROM dbo.Tareas AS t
    CROSS APPLY OPENJSON(t.Recipients) AS assigned
    INNER JOIN dbo.Usuarios AS u ON u.Name = assigned.[value]
    LEFT JOIN dbo.Clientes_Obras AS c ON c.ClientWorkId = t.ClientWorkId
    WHERE t.Estado IN (N'Pendiente', N'En proceso')
    ORDER BY u.UserId, t.CreatedAt;
  `);
  const byUser = new Map();
  for (const row of result.recordset) {
    const tasks = byUser.get(row.UserId) || { name: row.Name, email: row.Email, tasks: [] };
    tasks.tasks.push(row);
    byUser.set(row.UserId, tasks);
  }
  for (const [userId, user] of byUser) {
    if (!user.email || !user.email.trim()) {
      console.error(`No se puede enviar recordatorio: falta email para ${user.name} en dbo.Usuarios.`);
      continue;
    }
    if (!await claimEmailReminder(userId, reminderDate)) continue;
    const lines = user.tasks.map((task) => {
      const client = task.ClientWorkName ? ` · ${task.ClientWorkName}` : "";
      const due = task.DueDate ? ` · Vence: ${new Date(task.DueDate).toISOString().slice(0, 10)}` : "";
      return `- [${task.Estado}] ${task.Description}${client}${due}`;
    });
    const html = `<h2>Buen día, ${htmlEscape(user.name)}</h2><p>Tenés ${user.tasks.length} tarea(s) activa(s):</p><ul>${user.tasks.map((task) => {
      const client = task.ClientWorkName ? ` · ${htmlEscape(task.ClientWorkName)}` : "";
      const due = task.DueDate ? ` · Vence: ${new Date(task.DueDate).toISOString().slice(0, 10)}` : "";
      return `<li><strong>${htmlEscape(task.Estado)}</strong> — ${htmlEscape(task.Description)}${client}${due}</li>`;
    }).join("")}</ul><p>DIEC flow</p>`;
    try {
      await smtpTransport.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: user.email,
        subject: `DIEC flow: ${user.tasks.length} tarea(s) activa(s)`,
        text: `Buen día, ${user.name}.\n\nTenés ${user.tasks.length} tarea(s) activa(s):\n${lines.join("\n")}\n\nDIEC flow`,
        html,
      });
      await updateReminderStatus(userId, reminderDate, "Enviado");
      console.info(`Recordatorio por email enviado a ${user.email} (${reminderDate}).`);
    } catch (error) {
      await updateReminderStatus(userId, reminderDate, "Fallido", error.message.slice(0, 1000));
      console.error(`No se pudo enviar el recordatorio a ${user.email}:`, error.message);
    }
  }
}

async function handleRequest(request, response) {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    const isApi = url.pathname.startsWith("/api/");
    if (isApi && ["POST", "PATCH", "DELETE"].includes(request.method) && !originIsSame(request)) {
      return sendJson(response, 403, { error: "Origen de solicitud no permitido." });
    }
    if (isApi && request.method === "POST" && !["/api/session/login", "/api/session/logout"].includes(url.pathname)
      && !originIsSame(request)) {
      return sendJson(response, 403, { error: "Origen de solicitud no permitido." });
    }
    if (isApi) {
      const session = getSession(request);
      return await handleApi(request, response, url, session);
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return sendJson(response, 405, { error: "Método no permitido." });
    }
    const requestedPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    const allowedFiles = new Set([
      "/index.html",
      "/flow.css",
      "/flow.js",
      "/manifest.webmanifest",
      "/sw.js",
      "/diec-flow.svg",
      "/apple-touch-icon.png",
      "/icon-192.png",
      "/icon-512.png",
    ]);
    if (requestedPath !== "/index.html" && !allowedFiles.has(requestedPath)) {
      return sendJson(response, 404, { error: "No se encontró el recurso solicitado." });
    }
    const filePath = path.resolve(ROOT, `.${requestedPath}`);
    if (!filePath.startsWith(`${ROOT}${path.sep}`)) return sendJson(response, 400, { error: "Ruta no válida." });
    const content = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": ["index.html", "flow.css", "flow.js", "manifest.webmanifest", "sw.js"].includes(path.basename(filePath))
        ? "no-cache"
        : "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
      ...transportSecurityHeaders(request),
      ...(path.basename(filePath) === "sw.js" ? { "Service-Worker-Allowed": "/" } : {}),
    });
    response.end(request.method === "HEAD" ? undefined : content);
  } catch (error) {
    if (response.headersSent) return response.destroy(error);
    if (error.code === "ENOENT") return sendJson(response, 404, { error: "No se encontró el recurso solicitado." });
    console.error("Error procesando la solicitud:", error);
    return sendJson(response, error.status || 500, {
      error: error.status ? error.message : "Ocurrió un error interno.",
    });
  }
}

async function verifyDatabase() {
  const pool = await getSqlPool();
  await pool.request().query(`
    SELECT TOP (0) UserId, Name, Email FROM dbo.Usuarios;
    SELECT TOP (0) TaskId, Description, Recipients, Estado FROM dbo.Tareas;
    SELECT TOP (0) NotificationId, TaskId, Recipient FROM dbo.Notificaciones;
    SELECT TOP (0) UserId, ReminderDate, Status FROM dbo.RecordatoriosEmail;
  `);
  const result = await pool.request().query("SELECT Name FROM dbo.Usuarios;");
  const existingUsers = new Set(result.recordset.map((row) => row.Name));
  const missingUsers = USERS.filter((user) => !existingUsers.has(user));
  if (missingUsers.length) throw new Error(`Faltan usuarios en dbo.Usuarios. Ejecuta schema.sql: ${missingUsers.join(", ")}.`);
}

validateEnvironment();
await verifyDatabase();
cron.schedule("*/10 * * * *", () => {
  void sendDailyReminders().catch((error) => console.error("Falló el proceso de recordatorios por email:", error.message));
}, { timezone: TIMEZONE });

const server = createServer((request, response) => void handleRequest(request, response));
server.listen(PORT, () => {
  console.info(`DIEC flow disponible en el puerto ${PORT}.`);
  console.info(`Recordatorios por email desde las 08:00 (${TIMEZONE}), con reintento controlado.`);
});
