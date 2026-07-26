<?php

class Database
{
    private static $instance = null;
    private $pdo;

    private function __construct()
    {
        $dbPath = __DIR__ . '/../data/editor.sqlite';
        $dbDir = dirname($dbPath);

        if (!is_dir($dbDir)) {
            mkdir($dbDir, 0777, true);
        }

        $this->pdo = new PDO('sqlite:' . $dbPath);
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);

        $this->createTables();
    }

    public static function getInstance()
    {
        if (self::$instance === null) {
            self::$instance = new Database();
        }
        return self::$instance;
    }

    public function getConnection()
    {
        return $this->pdo;
    }

    private function createTables()
    {
        $commands = [
            'CREATE TABLE IF NOT EXISTS projects (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                directory_path TEXT NOT NULL UNIQUE,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )',
            'CREATE TABLE IF NOT EXISTS patches (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL,
                file_name TEXT NOT NULL,
                patch_type TEXT NOT NULL, -- "tone" or "drum"
                program_num INTEGER NOT NULL,
                bank_num INTEGER NOT NULL,
                preset_name TEXT,
                FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
            )'
        ];

        foreach ($commands as $command) {
            $this->pdo->exec($command);
        }
    }

    public function createProject($name, $directoryPath)
    {
        $stmt = $this->pdo->prepare('INSERT INTO projects (name, directory_path) VALUES (?, ?)');
        $stmt->execute([$name, $directoryPath]);
        return $this->pdo->lastInsertId();
    }

    public function addPatchToProject($projectId, $fileName, $patchType, $programNum, $bankNum, $presetName)
    {
        $stmt = $this->pdo->prepare(
            'INSERT INTO patches (project_id, file_name, patch_type, program_num, bank_num, preset_name) 
             VALUES (?, ?, ?, ?, ?, ?)'
        );
        $stmt->execute([$projectId, $fileName, $patchType, $programNum, $bankNum, $presetName]);
        return $this->pdo->lastInsertId();
    }
}