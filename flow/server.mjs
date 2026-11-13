import "dotenv/config";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cron from "node-cron";
import sql from "mssql";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(ROOT, "data");
const TASKS_FILE = path.join(DATA_DIR, "tasks.json");
const USERS = [
  "Pamela Pérez",
  "Nataniel Goyechea",
  "David Maglione",
  "Alen García",
  "Roberto Martin",
  "DIEC SAS",
];
const PORT = Number(process.env.PORT || 3000);
const TIMEZONE = process.env.APP_TIMEZONE || "America/Argentina/Buenos_Aires";
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function azureConfigured() {
  return ["AZURE_SQL_SERVER", "AZURE_SQL_DATABASE", "AZURE_SQL_USER", "AZURE_SQL_PASSWORD"]
    .every((key) => process.env[key] && !process.env[key].startsWith("your-"));
}

let sqlPool;
async function getSqlPool() {
  if (!azureConfigured()) return null;
  if (!sqlPool) {
    sqlPool = new sql.ConnectionPool({
      server: process.env.AZURE_SQL_SERVER,
      database: process.env.AZURE_SQL_DATABASE,
      user: process.env.AZURE_SQL_USER,
      password: process.env.AZURE_SQL_PASSWORD,
      options: { encrypt: true, trustServerCertificate: false },
      pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
      connectionTimeout: 10000,
      requestTimeout: 10000,
    }).connect().catch((error) => {
      sqlPool = undefined;
      throw error;
    });
  }
  return sqlPool;
}

let writes = Promise.resolve();
async function readTasksFile() {
  const content = await readFile(TASKS_FILE, "utf8");
  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed.tasks)) throw new Error("El archivo local de tareas no tiene un formato válido.");
  return parsed.tasks;
}

async function getTasks() {
  await writes;
  return readTasksFile();
}

function updateTasks(mutator) {
  const operation = writes.then(async () => {
    const tasks = await readTasksFile();
    const result = await mutator(tasks);
    const temporaryFile = `${TASKS_FILE}.${process.pid}.tmp`;
    await writeFile(temporaryFile, `${JSON.stringify({ tasks }, null, 2)}\n`, "utf8");
    await rename(temporaryFile, TASKS_FILE);
    return result;
  });
  writes = operation.catch(() => {});
  return operation;
}

async function syncCompletedTask(task) {
  if (task.azureSyncState === "synced") return task;
  const pool = await getSqlPool();
  if (!pool) return task;
  await pool.request()
    .input("taskId", sql.UniqueIdentifier, task.id)
    .input("description", sql.NVarChar(1000), task.description)
    .input("recipients", sql.NVarChar(500), JSON.stringify(task.recipients))
    .input("createdAt", sql.DateTimeOffset, new Date(task.createdAt))
    .input("dueDate", sql.Date, task.dueDate ? new Date(`${task.dueDate}T00:00:00.000Z`) : null)
    .input("completedAt", sql.DateTimeOffset, new Date(task.completedAt))
    .input("completedBy", sql.NVarChar(100), task.completedBy)
    .query(`
      IF NOT EXISTS (SELECT 1 FROM dbo.CompletedTasks WHERE TaskId = @taskId)
      INSERT INTO dbo.CompletedTasks (TaskId, Description, Recipients, CreatedAt, DueDate, CompletedAt, CompletedBy)
      VALUES (@taskId, @description, @recipients, @createdAt, @dueDate, @completedAt, @completedBy);
    `);
  return updateTasks((tasks) => {
    const stored = tasks.find((item) => item.id === task.id);
    if (stored) stored.azureSyncState = "synced";
    return stored;
  });
}

async function retryPendingSyncs() {
  if (!azureConfigured()) return;
  const pending = (await getTasks()).filter((task) => task.status === "completed" && task.azureSyncState !== "synced");
  for (const task of pending) {
    try {
      await syncCompletedTask(task);
    } catch (error) {
      console.error(`No se pudo sincronizar la tarea ${task.id} con Azure SQL:`, error.message);
    }
  }
}

async function sendDailyReminders() {
  const pending = (await getTasks()).filter((task) => task.status === "pending");
  const assignments = new Map(USERS.map((user) => [user, []]));
  for (const task of pending) {
    for (const recipient of task.recipients) assignments.get(recipient)?.push(task);
  }
  for (const [user, tasks] of assignments) {
    if (tasks.length) {
      console.info(`[Recordatorio simulado 08:00] ${user}: ${tasks.length} tarea(s) pendiente(s): ${tasks.map((task) => task.description).join("; ")}`);
    }
  }
}

function sendJson(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
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

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/users") {
    return sendJson(response, 200, { users: USERS });
  }

  if (request.method === "GET" && url.pathname === "/api/tasks") {
    const view = url.searchParams.get("view") || "personal";
    const status = url.searchParams.get("status") || "pending";
    const user = url.searchParams.get("user");
    if (!USERS.includes(user) || !["personal", "global"].includes(view) || !["pending", "completed"].includes(status)) {
      return sendJson(response, 400, { error: "El usuario, la vista o el estado seleccionados no son válidos." });
    }
    const tasks = (await getTasks())
      .filter((task) => task.status === status && (view === "global" || task.recipients.includes(user)))
      .sort((left, right) => status === "completed"
        ? new Date(right.completedAt) - new Date(left.completedAt)
        : 0);
    return sendJson(response, 200, { tasks });
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
    if (!USERS.includes(body.createdBy)) return sendJson(response, 400, { error: "El usuario creador no es válido." });
    if (!isValidDueDate(body.dueDate)) return sendJson(response, 400, { error: "La fecha de vencimiento no es válida." });

    const task = {
      id: randomUUID(),
      description,
      recipients,
      createdBy: body.createdBy,
      createdAt: new Date().toISOString(),
      dueDate: body.dueDate || null,
      status: "pending",
      azureSyncState: null,
    };
    await updateTasks((tasks) => tasks.push(task));
    return sendJson(response, 201, { task });
  }

  const completionMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/complete$/i);
  if (request.method === "PATCH" && completionMatch) {
    const body = await readJsonBody(request);
    if (!USERS.includes(body.completedBy)) return sendJson(response, 400, { error: "El usuario no es válido." });
    let task;
    await updateTasks((tasks) => {
      task = tasks.find((item) => item.id === completionMatch[1]);
      if (task && task.status === "pending") {
        task.status = "completed";
        task.completedAt = new Date().toISOString();
        task.completedBy = body.completedBy;
        task.azureSyncState = "pending";
      }
    });
    if (!task) return sendJson(response, 404, { error: "No se encontró la tarea." });
    if (task.status !== "completed") return sendJson(response, 409, { error: "No se pudo completar la tarea." });
    try {
      task = await syncCompletedTask(task);
    } catch (error) {
      console.error(`No se pudo sincronizar la tarea ${task.id} con Azure SQL:`, error.message);
    }
    return sendJson(response, 200, {
      task,
      azureSync: { status: task.azureSyncState, configured: azureConfigured() },
    });
  }

  return sendJson(response, 404, { error: "Ruta no encontrada." });
}

async function handleRequest(request, response) {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) return await handleApi(request, response, url);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return sendJson(response, 405, { error: "Método no permitido." });
    }
    const requestedPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    const filePath = path.resolve(ROOT, `.${requestedPath}`);
    if (!filePath.startsWith(`${ROOT}${path.sep}`)) {
      return sendJson(response, 400, { error: "Ruta no válida." });
    }
    const content = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    response.end(request.method === "HEAD" ? undefined : content);
  } catch (error) {
    if (response.headersSent) return response.destroy(error);
    if (error.code === "ENOENT") return sendJson(response, 404, { error: "No se encontró el recurso solicitado." });
    console.error("Error procesando la solicitud:", error);
    return sendJson(response, error.status || 500, { error: error.status ? error.message : "Ocurrió un error interno." });
  }
}

await mkdir(DATA_DIR, { recursive: true });
try {
  await readFile(TASKS_FILE);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  await writeFile(TASKS_FILE, '{"tasks":[]}\n', "utf8");
}

cron.schedule("0 8 * * *", () => {
  void sendDailyReminders().catch((error) => console.error("Falló el recordatorio diario:", error));
}, { timezone: TIMEZONE });
cron.schedule("*/5 * * * *", () => {
  void retryPendingSyncs().catch((error) => console.error("Falló el reintento de sincronización Azure:", error));
});

const server = createServer((request, response) => void handleRequest(request, response));
server.listen(PORT, () => {
  console.info(`DIEC flow disponible en http://localhost:${PORT}`);
  console.info(`Recordatorios simulados diarios a las 08:00 (${TIMEZONE}).`);
  if (!azureConfigured()) console.warn("Azure SQL no está configurado: las tareas completadas quedarán pendientes de sincronización.");
});
