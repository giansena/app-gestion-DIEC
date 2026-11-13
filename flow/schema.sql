IF OBJECT_ID(N'dbo.Clientes_Obras', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.Clientes_Obras (
        ClientWorkId UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
        Name NVARCHAR(150) NOT NULL,
        Description NVARCHAR(500) NULL,
        CreatedAt DATETIMEOFFSET NOT NULL
    );
END;

IF OBJECT_ID(N'dbo.Tareas', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.Tareas (
        TaskId UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
        Description NVARCHAR(1000) NOT NULL,
        Recipients NVARCHAR(500) NOT NULL,
        ClientWorkId UNIQUEIDENTIFIER NULL,
        Estado NVARCHAR(20) NOT NULL
            CONSTRAINT DF_Tareas_Estado DEFAULT N'Pendiente',
        CreatedBy NVARCHAR(100) NULL,
        CreatedAt DATETIMEOFFSET NOT NULL,
        DueDate DATE NULL,
        CompletedAt DATETIMEOFFSET NULL,
        CompletedBy NVARCHAR(100) NULL,
        CONSTRAINT CK_Tareas_Estado CHECK (Estado IN (N'Pendiente', N'En proceso', N'Completada')),
        CONSTRAINT FK_Tareas_Clientes_Obras
            FOREIGN KEY (ClientWorkId) REFERENCES dbo.Clientes_Obras (ClientWorkId)
    );
END;

IF COL_LENGTH(N'dbo.Tareas', N'CreatedBy') IS NULL
BEGIN
    ALTER TABLE dbo.Tareas ADD CreatedBy NVARCHAR(100) NULL;
END;

IF OBJECT_ID(N'dbo.Notificaciones', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.Notificaciones (
        NotificationId UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
        TaskId UNIQUEIDENTIFIER NOT NULL,
        Recipient NVARCHAR(100) NOT NULL,
        CreatedBy NVARCHAR(100) NOT NULL,
        Description NVARCHAR(1000) NOT NULL,
        ClientWorkName NVARCHAR(150) NULL,
        CreatedAt DATETIMEOFFSET NOT NULL,
        ReadAt DATETIMEOFFSET NULL
    );

    CREATE INDEX IX_Notificaciones_Recipient_CreatedAt
        ON dbo.Notificaciones (Recipient, CreatedAt DESC);
END;

IF OBJECT_ID(N'dbo.CompletedTasks', N'U') IS NOT NULL
BEGIN
    INSERT INTO dbo.Tareas (TaskId, Description, Recipients, ClientWorkId, Estado, CreatedAt, DueDate, CompletedAt, CompletedBy)
    SELECT legacy.TaskId, legacy.Description, legacy.Recipients, NULL, N'Completada',
           legacy.CreatedAt, legacy.DueDate, legacy.CompletedAt, legacy.CompletedBy
    FROM dbo.CompletedTasks AS legacy
    WHERE NOT EXISTS (SELECT 1 FROM dbo.Tareas AS task WHERE task.TaskId = legacy.TaskId);
END;
