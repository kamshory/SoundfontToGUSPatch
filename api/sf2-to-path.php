<?php

/**
 * SF2 to GUS Patch API Endpoint
 *
 * Handles SF2 file uploads, converts them to GUS patches,
 * and returns the result as a ZIP archive.
 */

require_once __DIR__ . '/../classes/SoundfontToGusPatch.php';

/**
 * Recursively deletes a directory and its contents.
 * @param string $dirPath The path to the directory to delete.
 */
function deleteDir($dirPath)
{
    if (!is_dir($dirPath)) {
        return;
    }
    if (substr($dirPath, strlen($dirPath) - 1, 1) != '/') {
        $dirPath .= '/';
    }
    $files = glob($dirPath . '*', GLOB_MARK);
    foreach ($files as $file) {
        if (is_dir($file)) {
            deleteDir($file);
        } else {
            unlink($file);
        }
    }
    rmdir($dirPath);
}

// --- 1. Handle File Upload ---
if ($_SERVER['REQUEST_METHOD'] !== 'POST' || !isset($_FILES['sf2file'])) {
    http_response_code(400); // Bad Request
    die(json_encode(['error' => 'Please upload an SF2 file using a POST request.']));
}

$uploadedFile = $_FILES['sf2file'];

if ($uploadedFile['error'] !== UPLOAD_ERR_OK) {
    http_response_code(500); // Internal Server Error
    die(json_encode(['error' => 'File upload failed with error code: ' . $uploadedFile['error']]));
}

$sf2FilePath = $uploadedFile['tmp_name'];
$originalFileName = basename($uploadedFile['name']);

if (strtolower(pathinfo($originalFileName, PATHINFO_EXTENSION)) !== 'sf2') {
    http_response_code(415); // Unsupported Media Type
    die(json_encode(['error' => 'Invalid file type. Only .sf2 files are allowed.']));
}

// --- 2. Prepare Temporary Directories ---
$tempParentDir = sys_get_temp_dir();
$outputDir = $tempParentDir . '/sf2_gus_' . uniqid() . time();

if (!mkdir($outputDir, 0777, true)) {
    http_response_code(500);
    die(json_encode(['error' => 'Failed to create temporary directory.']));
}

$zipFileName = pathinfo($originalFileName, PATHINFO_FILENAME) . '.zip';
$zipPath = $outputDir . '/' . $zipFileName;

try {
    // --- 3. Run Conversion ---
    $converter = new SoundfontToGusPatch();
    // Disable console logging for API usage
    $converter->setLogger(function ($message) { /* Do nothing */ });
    $converter->convert($sf2FilePath, $outputDir);

    // --- 4. Create ZIP Archive ---
    $zip = new ZipArchive();
    if ($zip->open($zipPath, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== TRUE) {
        throw new \Exception('Failed to create ZIP archive.');
    }

    // Create a RecursiveIteratorIterator to iterate through the output directory
    $files = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($outputDir),
        RecursiveIteratorIterator::LEAVES_ONLY
    );

    foreach ($files as $name => $file) {
        // Skip directories and the ZIP file itself
        if (!$file->isDir() && $file->getRealPath() !== realpath($zipPath)) {
            $filePath = $file->getRealPath();
            // Get relative path for proper structure inside ZIP
            $relativePath = substr($filePath, strlen($outputDir) + 1);
            $zip->addFile($filePath, $relativePath);
        }
    }
    $zip->close();

    // --- 5. Send ZIP to Client ---
    header('Content-Type: application/zip');
    header('Content-Disposition: attachment; filename="' . basename($zipPath) . '"');
    header('Content-Length: ' . filesize($zipPath));
    header('Connection: close');
    
    // Clear output buffer and read the file
    ob_clean();
    flush();
    readfile($zipPath);

} catch (\Exception $e) {
    http_response_code(500);
    die(json_encode(['error' => 'Conversion failed: ' . $e->getMessage()]));
} finally {
    // --- 6. Cleanup ---
    if (is_dir($outputDir)) {
        deleteDir($outputDir);
    }
}
