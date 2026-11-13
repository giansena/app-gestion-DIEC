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
const CLIENT_WORKS_FILE = path.join(DATA_DIR, "client-works.json");
const NOTIFICATIONS_FILE = path.join(DATA_DIR, "notifications.json");
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
let clientWorkWrites = Promise.resolve();
let notificationWrites = Promise.resolve();
async function readTasksFile() {
  const content = await readFile(TASKS_FILE, "utf8");
  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed.tasks)) throw new Error("El archivo local de tareas no tiene un formato válido.");
  return parsed.tasks;
}

async function readClientWorksFile() {
  const content = await readFile(CLIENT_WORKS_FILE, "utf8");
  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed.clientWorks)) throw new Error("El archivo local de clientes y obras no tiene un formato válido.");
  return parsed.clientWorks;
}

async function readNotificationsFile() {
  const content = await readFile(NOTIFICATIONS_FILE, "utf8");
  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed.notifications)) throw new Error("El archivo local de notificaciones no tiene un formato válido.");
  return parsed.notifications;
}

async function getTasks() {
  await writes;
  return readTasksFile();
}

async function getClientWorks() {
  await clientWorkWrites;
  return readClientWorksFile();
}

async function getNotifications() {
  await notificationWrites;
  return readNotificationsFile();
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

function updateClientWorks(mutator) {
  const operation = clientWorkWrites.then(async () => {
    const clientWorks = await readClientWorksFile();
    const result = await mutator(clientWorks);
    const temporaryFile = `${CLIENT_WORKS_FILE}.${process.pid}.tmp`;
    await writeFile(temporaryFile, `${JSON.stringify({ clientWorks }, null, 2)}\n`, "utf8");
    await rename(temporaryFile, CLIENT_WORKS_FILE);
    return result;
  });
  clientWorkWrites = operation.catch(() => {});
  return operation;
}

function updateNotifications(mutator) {
  const operation = notificationWrites.then(async () => {
    const notifications = await readNotificationsFile();
    const result = await mutator(notifications);
    const temporaryFile = `${NOTIFICATIONS_FILE}.${process.pid}.tmp`;
    await writeFile(temporaryFile, `${JSON.stringify({ notifications }, null, 2)}\n`, "utf8");
    await rename(temporaryFile, NOTIFICATIONS_FILE);
    return result;
  });
  notificationWrites = operation.catch(() => {});
  return operation;
}

async function syncClientWork(clientWork) {
  if (clientWork.azureSyncState === "synced") return clientWork;
  const pool = await getSqlPool();
  if (!pool) return clientWork;
  await pool.request()
    .input("clientWorkId", sql.UniqueIdentifier, clientWork.id)
    .input("name", sql.NVarChar(150), clientWork.name)
    .input("description", sql.NVarChar(500), clientWork.description || null)
    .input("createdAt", sql.DateTimeOffset, new Date(clientWork.createdAt))
    .query(`
      IF NOT EXISTS (SELECT 1 FROM dbo.Clientes_Obras WHERE ClientWorkId = @clientWorkId)
      INSERT INTO dbo.Clientes_Obras (ClientWorkId, Name, Description, CreatedAt)
      VALUES (@clientWorkId, @name, @description, @createdAt);
    `);
  return updateClientWorks((clientWorks) => {
    const stored = clientWorks.find((item) => item.id === clientWork.id);
    if (stored) stored.azureSyncState = "synced";
    return stored;
  });
}

async function syncTaskToAzure(task) {
  if (task.azureSyncState === "synced") return task;
  const pool = await getSqlPool();
  if (!pool) return task;
  const statusLabel = TASK_STATUS_LABELS[task.status];
  if (!statusLabel) throw new Error("El estado de la tarea no se puede sincronizar.");
  if (task.clientWorkId) {
    const clientWork = (await getClientWorks()).find((item) => item.id === task.clientWorkId);
    if (!clientWork) throw new Error("No se encontró el cliente / obra asociado a la tarea.");
    await syncClientWork(clientWork);
  }
  await pool.request()
    .input("taskId", sql.UniqueIdentifier, task.id)
    .input("description", sql.NVarChar(1000), task.description)
    .input("recipients", sql.NVarChar(500), JSON.stringify(task.recipients))
    .input("clientWorkId", sql.UniqueIdentifier, task.clientWorkId || null)
    .input("status", sql.NVarChar(20), statusLabel)
    .input("createdBy", sql.NVarChar(100), task.createdBy || null)
    .input("createdAt", sql.DateTimeOffset, new Date(task.createdAt))
    .input("dueDate", sql.Date, task.dueDate ? new Date(`${task.dueDate}T00:00:00.000Z`) : null)
    .input("completedAt", sql.DateTimeOffset, task.completedAt ? new Date(task.completedAt) : null)
    .input("completedBy", sql.NVarChar(100), task.completedBy || null)
    .query(`
      IF EXISTS (SELECT 1 FROM dbo.Tareas WHERE TaskId = @taskId)
        UPDATE dbo.Tareas
        SET Description = @description,
            Recipients = @recipients,
            ClientWorkId = @clientWorkId,
            Estado = @status,
            CreatedBy = COALESCE(CreatedBy, @createdBy),
            DueDate = @dueDate,
            CompletedAt = @completedAt,
            CompletedBy = @completedBy
        WHERE TaskId = @taskId;
      ELSE
        INSERT INTO dbo.Tareas (TaskId, Description, Recipients, ClientWorkId, Estado, CreatedBy, CreatedAt, DueDate, CompletedAt, CompletedBy)
        VALUES (@taskId, @description, @recipients, @clientWorkId, @status, @createdBy, @createdAt, @dueDate, @completedAt, @completedBy);
    `);
  return updateTasks((tasks) => {
    const stored = tasks.find((item) => item.id === task.id);
    if (stored) stored.azureSyncState = "synced";
    return stored;
  });
}

async function syncNotificationToAzure(notification) {
  const pool = await getSqlPool();
  if (!pool) return notification;
  await pool.request()
    .input("notificationId", sql.UniqueIdentifier, notification.id)
    .input("taskId", sql.UniqueIdentifier, notification.taskId)
    .input("recipient", sql.NVarChar(100), notification.recipient)
    .input("createdBy", sql.NVarChar(100), notification.createdBy)
    .input("description", sql.NVarChar(1000), notification.description)
    .input("clientWorkName", sql.NVarChar(150), notification.clientWorkName || null)
    .input("createdAt", sql.DateTimeOffset, new Date(notification.createdAt))
    .input("readAt", sql.DateTimeOffset, notification.readAt ? new Date(notification.readAt) : null)
    .query(`
      IF EXISTS (SELECT 1 FROM dbo.Notificaciones WHERE NotificationId = @notificationId)
        UPDATE dbo.Notificaciones
        SET TaskId = @taskId,
            Recipient = @recipient,
            CreatedBy = @createdBy,
            Description = @description,
            ClientWorkName = @clientWorkName,
            CreatedAt = @createdAt,
            ReadAt = @readAt
        WHERE NotificationId = @notificationId;
      ELSE
        INSERT INTO dbo.Notificaciones
          (NotificationId, TaskId, Recipient, CreatedBy, Description, ClientWorkName, CreatedAt, ReadAt)
        VALUES
          (@notificationId, @taskId, @recipient, @createdBy, @description, @clientWorkName, @createdAt, @readAt);
    `);
  return updateNotifications((notifications) => {
    const stored = notifications.find((item) => item.id === notification.id);
    if (stored) stored.azureSyncState = "synced";
    return stored;
  });
}

async function createTaskNotifications(task, clientWorkName, recipients = task.recipients, assignedBy = task.createdBy) {
  const createdAt = new Date().toISOString();
  const notifications = recipients.map((recipient) => ({
    id: randomUUID(),
    taskId: task.id,
    recipient,
    createdBy: assignedBy || task.createdBy,
    description: task.description,
    clientWorkName: clientWorkName || null,
    createdAt,
    readAt: null,
    azureSyncState: "pending",
  }));
  await updateNotifications((stored) => stored.push(...notifications));
  await Promise.all(notifications.map(async (notification) => {
    try {
      await syncNotificationToAzure(notification);
    } catch (error) {
      console.error(`No se pudo sincronizar la notificación ${notification.id} con Azure SQL:`, error.message);
    }
  }));
}

async function deleteTaskNotifications(taskId, syncAzure = true) {
  const pool = syncAzure ? await getSqlPool() : null;
  if (!pool && syncAzure) {
    await updateNotifications((notifications) => {
      for (const notification of notifications) {
        if (notification.taskId === taskId) {
          notification.status = "deleted";
          notification.azureSyncState = "delete_pending";
        }
      }
    });
    return;
  }
  if (pool) {
    await pool.request()
      .input("taskId", sql.UniqueIdentifier, taskId)
      .query("DELETE FROM dbo.Notificaciones WHERE TaskId = @taskId;");
  }
  await updateNotifications((notifications) => {
    for (let index = notifications.length - 1; index >= 0; index -= 1) {
      if (notifications[index].taskId === taskId) notifications.splice(index, 1);
    }
  });
}

async function deleteTaskFromAzure(task) {
  const pool = await getSqlPool();
  if (!pool) {
    await deleteTaskNotifications(task.id);
    return task;
  }
  await deleteTaskNotifications(task.id);
  await pool.request()
    .input("taskId", sql.UniqueIdentifier, task.id)
    .query("DELETE FROM dbo.Tareas WHERE TaskId = @taskId;");
  await updateTasks((tasks) => {
    const index = tasks.findIndex((item) => item.id === task.id && item.status === "deleted");
    if (index >= 0) tasks.splice(index, 1);
  });
  return { ...task, azureSyncState: "synced" };
}

async function deleteClientWorkFromAzure(clientWork) {
  const pool = await getSqlPool();
  if (!pool) return clientWork;
  await pool.request()
    .input("clientWorkId", sql.UniqueIdentifier, clientWork.id)
    .query("DELETE FROM dbo.Clientes_Obras WHERE ClientWorkId = @clientWorkId;");
  await updateClientWorks((clientWorks) => {
    const index = clientWorks.findIndex((item) => item.id === clientWork.id && item.status === "deleted");
    if (index >= 0) clientWorks.splice(index, 1);
  });
  return { ...clientWork, azureSyncState: "synced" };
}

async function retryPendingSyncs() {
  if (!azureConfigured()) return;
  const deletedTasks = (await getTasks()).filter((task) => task.status === "deleted" && task.azureSyncState === "delete_pending");
  for (const task of deletedTasks) {
    try {
      await deleteTaskFromAzure(task);
    } catch (error) {
      console.error(`No se pudo eliminar la tarea ${task.id} de Azure SQL:`, error.message);
    }
  }
  const deletedClientWorks = (await getClientWorks()).filter((clientWork) => clientWork.status === "deleted" && clientWork.azureSyncState === "delete_pending");
  for (const clientWork of deletedClientWorks) {
    try {
      await deleteClientWorkFromAzure(clientWork);
    } catch (error) {
      console.error(`No se pudo eliminar el cliente / obra ${clientWork.id} de Azure SQL:`, error.message);
    }
  }
  const pendingClientWorks = (await getClientWorks()).filter((clientWork) => clientWork.status !== "deleted" && clientWork.azureSyncState !== "synced");
  for (const clientWork of pendingClientWorks) {
    try {
      await syncClientWork(clientWork);
    } catch (error) {
      console.error(`No se pudo sincronizar el cliente / obra ${clientWork.id} con Azure SQL:`, error.message);
    }
  }
  const pending = (await getTasks()).filter((task) => task.status !== "deleted" && task.azureSyncState === "pending");
  for (const task of pending) {
    try {
      await syncTaskToAzure(task);
    } catch (error) {
      console.error(`No se pudo sincronizar la tarea ${task.id} con Azure SQL:`, error.message);
    }
  }
  const deletedTaskIds = new Set((await getTasks()).filter((task) => task.status === "deleted").map((task) => task.id));
  const pendingNotifications = (await getNotifications())
    .filter((notification) => notification.azureSyncState !== "synced" && !deletedTaskIds.has(notification.taskId));
  for (const notification of pendingNotifications) {
    try {
      await syncNotificationToAzure(notification);
    } catch (error) {
      console.error(`No se pudo sincronizar la notificación ${notification.id} con Azure SQL:`, error.message);
    }
  }
}

async function sendDailyReminders() {
  const pending = (await getTasks()).filter((task) => ["pending", "in_progress"].includes(task.status));
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

  if (request.method === "GET" && url.pathname === "/api/client-works") {
    const clientWorks = (await getClientWorks()).filter((clientWork) => clientWork.status !== "deleted");
    return sendJson(response, 200, { clientWorks });
  }

  if (request.method === "GET" && url.pathname === "/api/notifications") {
    const user = url.searchParams.get("user");
    if (!USERS.includes(user)) return sendJson(response, 400, { error: "El usuario seleccionado no es válido." });
    const deletedTaskIds = new Set((await getTasks()).filter((task) => task.status === "deleted").map((task) => task.id));
    const notifications = (await getNotifications())
      .filter((notification) => notification.recipient === user
        && notification.status !== "deleted"
        && !deletedTaskIds.has(notification.taskId))
      .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
    return sendJson(response, 200, { notifications });
  }

  const notificationReadMatch = url.pathname.match(/^\/api\/notifications\/([0-9a-f-]+)\/read$/i);
  if (request.method === "PATCH" && notificationReadMatch) {
    const body = await readJsonBody(request);
    if (!USERS.includes(body.user)) return sendJson(response, 400, { error: "El usuario seleccionado no es válido." });
    let notification;
    await updateNotifications((notifications) => {
      notification = notifications.find((item) => item.id === notificationReadMatch[1]
        && item.recipient === body.user
        && item.status !== "deleted");
      if (notification && !notification.readAt) {
        notification.readAt = new Date().toISOString();
        notification.azureSyncState = "pending";
      }
    });
    if (!notification) return sendJson(response, 404, { error: "No se encontró la notificación." });
    try {
      notification = await syncNotificationToAzure(notification);
    } catch (error) {
      console.error(`No se pudo sincronizar la notificación ${notification.id} con Azure SQL:`, error.message);
    }
    return sendJson(response, 200, { notification });
  }

  if (request.method === "POST" && url.pathname === "/api/client-works") {
    const body = await readJsonBody(request);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    if (!name || name.length > 150) {
      return sendJson(response, 400, { error: "El nombre es obligatorio y debe tener hasta 150 caracteres." });
    }
    if (description.length > 500) {
      return sendJson(response, 400, { error: "La descripción debe tener hasta 500 caracteres." });
    }
    let clientWork;
    await updateClientWorks((clientWorks) => {
      const duplicate = clientWorks.some((item) => item.status !== "deleted"
        && item.name.toLocaleLowerCase("es") === name.toLocaleLowerCase("es"));
      if (duplicate) return null;
      clientWork = {
        id: randomUUID(),
        name,
        description,
        createdAt: new Date().toISOString(),
        azureSyncState: "pending",
      };
      clientWorks.push(clientWork);
      return clientWork;
    });
    if (!clientWork) return sendJson(response, 409, { error: "Ya existe un cliente / obra con ese nombre." });
    try {
      clientWork = await syncClientWork(clientWork);
    } catch (error) {
      console.error(`No se pudo sincronizar el cliente / obra ${clientWork.id} con Azure SQL:`, error.message);
    }
    return sendJson(response, 201, { clientWork });
  }

  const clientWorkDeletionMatch = url.pathname.match(/^\/api\/client-works\/([0-9a-f-]+)$/i);
  if (request.method === "DELETE" && clientWorkDeletionMatch) {
    const clientWorkId = clientWorkDeletionMatch[1];
    const associatedTasks = (await getTasks()).some((task) => task.clientWorkId === clientWorkId && task.status !== "deleted");
    if (associatedTasks) {
      return sendJson(response, 409, { error: "Primero eliminá las tareas asociadas a este cliente / obra." });
    }
    let clientWork;
    let shouldSync = false;
    await updateClientWorks((clientWorks) => {
      clientWork = clientWorks.find((item) => item.id === clientWorkId);
      if (!clientWork) return;
      if (clientWork.status !== "deleted") {
        clientWork.status = "deleted";
        clientWork.azureSyncState = "delete_pending";
      }
      shouldSync = clientWork.azureSyncState === "delete_pending";
    });
    if (!clientWork) return sendJson(response, 404, { error: "No se encontró el cliente / obra." });
    if (shouldSync) {
      try {
        clientWork = await deleteClientWorkFromAzure(clientWork);
      } catch (error) {
        console.error(`No se pudo eliminar el cliente / obra ${clientWork.id} de Azure SQL:`, error.message);
      }
    }
    return sendJson(response, 200, {
      deleted: true,
      azureSync: shouldSync ? { status: clientWork.azureSyncState, configured: azureConfigured() } : null,
    });
  }

  if (request.method === "GET" && url.pathname === "/api/tasks") {
    const view = url.searchParams.get("view") || "personal";
    const status = url.searchParams.get("status") || "active";
    const user = url.searchParams.get("user");
    if (!USERS.includes(user) || !["personal", "global"].includes(view) || !["active", "completed"].includes(status)) {
      return sendJson(response, 400, { error: "El usuario, la vista o el estado seleccionados no son válidos." });
    }
    const clientWorks = await getClientWorks();
    const clientWorkNames = new Map(clientWorks
      .filter((item) => item.status !== "deleted")
      .map((item) => [item.id, item.name]));
    const tasks = (await getTasks())
      .filter((task) => (status === "completed" ? task.status === "completed" : ["pending", "in_progress"].includes(task.status))
        && (view === "global" || task.recipients.includes(user)))
      .map((task) => ({ ...task, clientWorkName: clientWorkNames.get(task.clientWorkId) || null }))
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
    const clientWorkId = body.clientWorkId || null;
    const clientWorks = clientWorkId ? await getClientWorks() : [];
    if (clientWorkId && !clientWorks.some((item) => item.id === clientWorkId && item.status !== "deleted")) {
      return sendJson(response, 400, { error: "El cliente / obra seleccionado no existe." });
    }

    const task = {
      id: randomUUID(),
      description,
      recipients,
      createdBy: body.createdBy,
      createdAt: new Date().toISOString(),
      dueDate: body.dueDate || null,
      clientWorkId,
      status: "pending",
      azureSyncState: "pending",
    };
    await updateTasks((tasks) => tasks.push(task));
    const clientWorkName = clientWorkId
      ? clientWorks.find((item) => item.id === clientWorkId)?.name || null
      : null;
    await createTaskNotifications(task, clientWorkName);
    try {
      Object.assign(task, await syncTaskToAzure(task));
    } catch (error) {
      console.error(`No se pudo sincronizar la tarea ${task.id} con Azure SQL:`, error.message);
    }
    return sendJson(response, 201, { task });
  }

  const taskUpdateMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)$/i);
  if (request.method === "PATCH" && taskUpdateMatch) {
    const body = await readJsonBody(request);
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const recipients = Array.isArray(body.recipients) ? [...new Set(body.recipients)] : [];
    if (!description || description.length > 1000) {
      return sendJson(response, 400, { error: "La descripción es obligatoria y debe tener hasta 1000 caracteres." });
    }
    if (!recipients.length || recipients.some((name) => !USERS.includes(name))) {
      return sendJson(response, 400, { error: "Elegí al menos un destinatario válido." });
    }
    if (!USERS.includes(body.updatedBy)) return sendJson(response, 400, { error: "El usuario que realiza la edición no es válido." });
    if (!isValidDueDate(body.dueDate)) return sendJson(response, 400, { error: "La fecha de vencimiento no es válida." });
    const clientWorkId = body.clientWorkId || null;
    const clientWorks = clientWorkId ? await getClientWorks() : [];
    const clientWork = clientWorkId
      ? clientWorks.find((item) => item.id === clientWorkId && item.status !== "deleted")
      : null;
    if (clientWorkId && !clientWork) {
      return sendJson(response, 400, { error: "El cliente / obra seleccionado no existe." });
    }

    let task;
    let addedRecipients = [];
    await updateTasks((tasks) => {
      task = tasks.find((item) => item.id === taskUpdateMatch[1]);
      if (!task || task.status === "deleted") return;
      if (!["pending", "in_progress"].includes(task.status)) return;
      addedRecipients = recipients.filter((recipient) => !task.recipients.includes(recipient));
      Object.assign(task, {
        description,
        recipients,
        clientWorkId,
        dueDate: body.dueDate || null,
        azureSyncState: "pending",
      });
    });
    if (!task) return sendJson(response, 404, { error: "No se encontró la tarea." });
    if (task.status === "deleted") return sendJson(response, 409, { error: "La tarea ya fue eliminada." });
    if (!["pending", "in_progress"].includes(task.status)) {
      return sendJson(response, 409, { error: "Solo se pueden editar tareas Pendientes o En proceso." });
    }

    if (addedRecipients.length) {
      await createTaskNotifications(task, clientWork?.name || null, addedRecipients, body.updatedBy);
    }
    try {
      task = await syncTaskToAzure(task);
    } catch (error) {
      console.error(`No se pudo sincronizar la tarea ${task.id} con Azure SQL:`, error.message);
    }
    return sendJson(response, 200, {
      task: { ...task, clientWorkName: clientWork?.name || null },
      azureSync: { status: task.azureSyncState, configured: azureConfigured() },
    });
  }

  const taskDeletionMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)$/i);
  if (request.method === "DELETE" && taskDeletionMatch) {
    const taskId = taskDeletionMatch[1];
    let task;
    let shouldSync = false;
    await updateTasks((tasks) => {
      const index = tasks.findIndex((item) => item.id === taskId);
      if (index < 0) return;
      task = tasks[index];
      if (task.status === "deleted") {
        shouldSync = task.azureSyncState === "delete_pending";
      } else if (task.azureSyncState) {
        task.status = "deleted";
        task.azureSyncState = "delete_pending";
        shouldSync = true;
      } else {
        tasks.splice(index, 1);
      }
    });
    if (!task) return sendJson(response, 404, { error: "No se encontró la tarea." });
    if (shouldSync) {
      try {
        task = await deleteTaskFromAzure(task);
      } catch (error) {
        console.error(`No se pudo eliminar la tarea ${task.id} de Azure SQL:`, error.message);
      }
    } else {
      await deleteTaskNotifications(task.id, false);
    }
    return sendJson(response, 200, {
      deleted: true,
      azureSync: shouldSync ? { status: task.azureSyncState, configured: azureConfigured() } : null,
    });
  }

  const statusMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/status$/i);
  if (request.method === "PATCH" && statusMatch) {
    const body = await readJsonBody(request);
    if (!["pending", "in_progress"].includes(body.status)) {
      return sendJson(response, 400, { error: "El estado debe ser Pendiente o En proceso." });
    }
    let task;
    let shouldSync = false;
    await updateTasks((tasks) => {
      task = tasks.find((item) => item.id === statusMatch[1]);
      if (!task || task.status === "deleted" || (task.status === "completed" && body.status !== "pending")) return;
      if (task.status === body.status) return;
      const wasCompleted = task.status === "completed";
      task.status = body.status;
      if (wasCompleted) {
        task.completedAt = null;
        task.completedBy = null;
      }
      if (wasCompleted || task.azureSyncState) {
        task.azureSyncState = "pending";
        shouldSync = true;
      }
    });
    if (!task) return sendJson(response, 404, { error: "No se encontró la tarea." });
    if (task.status === "deleted") return sendJson(response, 409, { error: "La tarea ya fue eliminada." });
    if (task.status === "completed") return sendJson(response, 409, { error: "No se puede cambiar el estado de una tarea completada." });
    if (shouldSync) {
      try {
        task = await syncTaskToAzure(task);
      } catch (error) {
        console.error(`No se pudo sincronizar la tarea ${task.id} con Azure SQL:`, error.message);
      }
    }
    const clientWork = task.clientWorkId
      ? (await getClientWorks()).find((item) => item.id === task.clientWorkId && item.status !== "deleted")
      : null;
    return sendJson(response, 200, {
      task: { ...task, clientWorkName: clientWork?.name || null },
      azureSync: shouldSync ? { status: task.azureSyncState, configured: azureConfigured() } : null,
    });
  }

  const completionMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/complete$/i);
  if (request.method === "PATCH" && completionMatch) {
    const body = await readJsonBody(request);
    if (!USERS.includes(body.completedBy)) return sendJson(response, 400, { error: "El usuario no es válido." });
    let task;
    await updateTasks((tasks) => {
      task = tasks.find((item) => item.id === completionMatch[1]);
      if (task && ["pending", "in_progress"].includes(task.status)) {
        task.status = "completed";
        task.completedAt = new Date().toISOString();
        task.completedBy = body.completedBy;
        task.azureSyncState = "pending";
      }
    });
    if (!task) return sendJson(response, 404, { error: "No se encontró la tarea." });
    if (task.status !== "completed") return sendJson(response, 409, { error: "No se pudo completar la tarea." });
    try {
      task = await syncTaskToAzure(task);
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
try {
  await readFile(CLIENT_WORKS_FILE);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  await writeFile(CLIENT_WORKS_FILE, '{"clientWorks":[]}\n', "utf8");
}
try {
  await readFile(NOTIFICATIONS_FILE);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  await writeFile(NOTIFICATIONS_FILE, '{"notifications":[]}\n', "utf8");
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
