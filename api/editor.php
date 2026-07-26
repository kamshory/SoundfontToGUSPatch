<?php

require_once __DIR__ . '/../classes/SoundfontToGusPatch.php';
require_once __DIR__ . '/../classes/Database.php';

header('Content-Type: application/json');

$action = isset($_GET['action']) ? $_GET['action'] : '';
$projectsBaseDir = __DIR__ . '/../projects';

try {
    $db = Database::getInstance();
    $pdo = $db->getConnection();

    switch ($action) {
        case 'list_projects':
            $stmt = $pdo->query('SELECT id, name, directory_path, created_at FROM projects ORDER BY created_at DESC');
            echo json_encode($stmt->fetchAll());
            break;

        case 'create_project':
            $data = json_decode(file_get_contents('php://input'), true);
            $projectName = isset($data['name']) ? trim($data['name']) : '';

            if (empty($projectName)) {
                throw new Exception('Project name cannot be empty.');
            }

            $safeDirName = preg_replace('/[^a-zA-Z0-9_\-]/', '_', $projectName) . '_' . time();
            $projectPath = $projectsBaseDir . '/' . $safeDirName;

            if (!is_dir($projectsBaseDir)) mkdir($projectsBaseDir, 0777, true);
            if (!mkdir($projectPath, 0777, true)) {
                throw new Exception('Failed to create project directory.');
            }

            $projectId = $db->createProject($projectName, $safeDirName);
            echo json_encode(['success' => true, 'id' => $projectId, 'name' => $projectName, 'path' => $safeDirName]);
            break;

        case 'upload_sf2':
            $projectId = isset($_POST['project_id']) ? (int)$_POST['project_id'] : 0;
            if ($projectId === 0) {
                throw new Exception('Invalid Project ID.');
            }

            // Find project directory from DB
            $stmt = $pdo->prepare('SELECT directory_path FROM projects WHERE id = ?');
            $stmt->execute([$projectId]);
            $project = $stmt->fetch();

            if (!$project) {
                throw new Exception('Project not found.');
            }

            $outputDir = $projectsBaseDir . '/' . $project['directory_path'];

            // --- Logic to handle patch updates ---
            // 1. Get a list of all existing patch files for this project before conversion.
            $stmtOldFiles = $pdo->prepare('SELECT id, file_name FROM patches WHERE project_id = ?');
            $stmtOldFiles->execute([$projectId]);
            $oldPatches = $stmtOldFiles->fetchAll(PDO::FETCH_KEY_PAIR); // [id => file_name]
            // ---

            // Handle file upload
            if (!isset($_FILES['sf2file']) || $_FILES['sf2file']['error'] !== UPLOAD_ERR_OK) {
                throw new Exception('File upload failed.');
            }

            $sf2FilePath = $_FILES['sf2file']['tmp_name'];
            if (strtolower(pathinfo($_FILES['sf2file']['name'], PATHINFO_EXTENSION)) !== 'sf2') {
                throw new Exception('Invalid file type. Only .sf2 files are allowed.');
            }

            // Run conversion
            $converter = new SoundfontToGusPatch();
            $converter->setLogger(function ($message) { /* Silent for API */ });
            $converter->setDatabase($db);
            $converter->setProjectId($projectId);
            $converter->convert($sf2FilePath, $outputDir);

            // --- Logic to clean up old/updated patches ---
            // 2. Get the list of patches after conversion.
            $stmtNewFiles = $pdo->prepare('SELECT file_name FROM patches WHERE project_id = ?');
            $stmtNewFiles->execute([$projectId]);
            $newPatchFiles = $stmtNewFiles->fetchAll(PDO::FETCH_COLUMN);
            $newPatchFilesSet = array_flip($newPatchFiles); // Use as a fast-lookup set

            $deletedCount = 0;
            // 3. Compare old list with new list and delete what's no longer needed.
            foreach ($oldPatches as $patchId => $oldFileName) {
                if (!isset($newPatchFilesSet[$oldFileName])) {
                    // This file is no longer part of the project, delete it.
                    $fullPath = $outputDir . '/' . $oldFileName;
                    if (file_exists($fullPath)) {
                        unlink($fullPath);
                    }
                    // Also remove from database
                    $stmtDelete = $pdo->prepare('DELETE FROM patches WHERE id = ?');
                    $stmtDelete->execute([$patchId]);
                    $deletedCount++;
                }
            }
            // ---

            echo json_encode(['success' => true, 'message' => 'SF2 converted. ' . ($deletedCount > 0 ? "$deletedCount old patches cleaned up." : "")]);
            break;

        case 'get_project_details':
            $projectId = isset($_GET['project_id']) ? (int)$_GET['project_id'] : 0;
            $stmt = $pdo->prepare('SELECT * FROM patches WHERE project_id = ? ORDER BY patch_type, program_num');
            $stmt->execute([$projectId]);
            echo json_encode($stmt->fetchAll());
            break;

        case 'get_patch_data':
            $patchId = isset($_GET['patch_id']) ? (int)$_GET['patch_id'] : 0;
            $stmt = $pdo->prepare(
                'SELECT p.file_name, pr.directory_path 
                 FROM patches p 
                 JOIN projects pr ON p.project_id = pr.id 
                 WHERE p.id = ?'
            );
            $stmt->execute([$patchId]);
            $patchInfo = $stmt->fetch();

            if (!$patchInfo) {
                throw new Exception('Patch not found.');
            }

            $filePath = $projectsBaseDir . '/' . $patchInfo['directory_path'] . '/' . $patchInfo['file_name'];
            if (!file_exists($filePath)) {
                throw new Exception('Patch file does not exist.');
            }

            header('Content-Type: application/octet-stream');
            header('Content-Length: ' . filesize($filePath));
            readfile($filePath);
            exit;

        case 'save_patch_data':
            // Implementasi untuk menyimpan data patch yang sudah diubah.
            // Ini memerlukan path file dan data biner dari request.
            // Untuk saat ini, kita buat placeholder.
            echo json_encode(['success' => true, 'message' => 'Save functionality to be implemented.']);
            break;

        case 'download_project':
            // This part is similar to the old sf2-to-path.php but for an existing project dir
            $projectId = isset($_GET['project_id']) ? (int)$_GET['project_id'] : 0;
            $stmt = $pdo->prepare('SELECT name, directory_path FROM projects WHERE id = ?');
            $stmt->execute([$projectId]);
            $project = $stmt->fetch();

            if (!$project) {
                throw new Exception('Project not found.');
            }

            $projectDir = $projectsBaseDir . '/' . $project['directory_path'];
            $zipFileName = sys_get_temp_dir() . '/' . $project['directory_path'] . '.zip';

            $zip = new ZipArchive();
            if ($zip->open($zipFileName, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== TRUE) {
                throw new \Exception('Failed to create ZIP archive.');
            }

            $files = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($projectDir), RecursiveIteratorIterator::LEAVES_ONLY);
            foreach ($files as $name => $file) {
                if (!$file->isDir()) {
                    $filePath = $file->getRealPath();
                    $relativePath = substr($filePath, strlen($projectDir) + 1);
                    $zip->addFile($filePath, $relativePath);
                }
            }
            $zip->close();

            header('Content-Type: application/zip');
            header('Content-Disposition: attachment; filename="' . $project['name'] . '.zip"');
            header('Content-Length: ' . filesize($zipFileName));
            ob_clean();
            flush();
            readfile($zipFileName);
            unlink($zipFileName); // Clean up temp zip
            exit;

        default:
            http_response_code(404);
            echo json_encode(['error' => 'Action not found.']);
            break;
    }
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
