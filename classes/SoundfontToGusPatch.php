<?php
/**
 * SoundfontToGusPatch Class
 *
 * Converts a SoundFont 2 (.sf2) file into a set of compatible GUS Patch (.pat)
 * files and a timidity.cfg configuration file.
 *
 * @version 1.0
 * @author Gemini Code Assist
 */
class SoundfontToGusPatch
{
    /** @var string */
    private $sf2FilePath;
    /** @var string */
    private $outputDir;
    /** @var resource|false */
    private $fp;
    /** @var array */
    private $pdtaChunks = [];
    /** @var int */
    private $smplOffset = 0;
    /** @var array */
    private $shdr_list = [];
    /** @var array */
    private $inst_list = [];
    /** @var array */
    private $phdr_list = [];
    /** @var array */
    private $timidityMap = [];
    /** @var int */
    private $convertedCount = 0;
    /** @var callable */
    private $logger;
    /** @var int|null */
    private $projectId = null;
    /** @var Database|null */
    private $db = null;

    /**
     * Main conversion function.
     *
     * @param string $sourceFilePath Path to the source .sf2 file.
     * @param string $outputDirectory Path to the output directory.
     * @throws \Exception If an error occurs during the conversion process.
     */
    public function convert($sourceFilePath, $outputDirectory)
    {
        $this->initialize($sourceFilePath, $outputDirectory);

        try {
            $this->parseRiffAndFindChunks();
            $this->parsePdtaSubChunks();
            $this->processPresetsAndGeneratePatches();
            $this->writeTimidityConfig();

            $this->log("\nDone! Successfully converted {$this->convertedCount} .pat files.");
            $this->log("Files saved in: {$this->outputDir}");
            $this->log("Configuration file timidity.cfg created in: {$this->outputDir}/timidity.cfg");

        } finally {
            if (is_resource($this->fp)) {
                fclose($this->fp);
            }
        }
    }

    /**
     * Sets a custom logging function.
     *
     * @param callable $logger The function to use for logging. It should accept one string argument.
     */
    public function setLogger($logger)
    {
        $this->logger = $logger;
    }

    /**
     * Sets the project ID for database logging.
     * @param int $projectId
     */
    public function setProjectId($projectId)
    {
        $this->projectId = $projectId;
    }

    /**
     * Sets the database manager instance.
     * @param Database $db
     */
    public function setDatabase(Database $db)
    {
        $this->db = $db;
    }


    /**
     * Logs a message using the configured logger.
     *
     * @param string $message The message to log.
     */
    private function log($message)
    {
        if (is_callable($this->logger)) {
            call_user_func($this->logger, $message);
        }
    }

    /**
     * @param string $sourceFilePath
     * @param string $outputDirectory
     * @throws \Exception
     */
    private function initialize($sourceFilePath, $outputDirectory)
    {
        if (!file_exists($sourceFilePath)) {
            throw new \Exception("Error: SF2 file not found at '{$sourceFilePath}'.");
        }
        $this->sf2FilePath = $sourceFilePath;
        $this->outputDir = $outputDirectory;

        if (!isset($this->logger)) {
            $this->setLogger(function ($message) {
                echo $message . "\n";
            });
        }

        $this->log("Reading SF2 file: " . basename($this->sf2FilePath) . "...");

        $this->fp = fopen($this->sf2FilePath, 'rb');
        if (!$this->fp) {
            throw new \Exception("Error: Failed to open SF2 file.");
        }
    }

    private function parseRiffAndFindChunks()
    {
        $riffHeader = fread($this->fp, 12);
        if (substr($riffHeader, 0, 4) !== 'RIFF' || substr($riffHeader, 8, 4) !== 'sfbk') {
            throw new \Exception("Error: Not a valid SF2 file format.");
        }

        while (!feof($this->fp)) {
            $chunkHeader = fread($this->fp, 8);
            if (strlen($chunkHeader) < 8) break;

            $id   = substr($chunkHeader, 0, 4);
            $size = unpack('V', substr($chunkHeader, 4, 4))[1];

            if ($id === 'LIST') {
                $type = fread($this->fp, 4);
                $listContent = fread($this->fp, $size - 4);
                if ($type === 'sdta') {
                    $this->smplOffset = ftell($this->fp) - strlen($listContent) + 8;
                } elseif ($type === 'pdta') {
                    $offset = 0;
                    while ($offset < strlen($listContent)) {
                        $subId = substr($listContent, $offset, 4);
                        $subSize = unpack('V', substr($listContent, $offset + 4, 4))[1];
                        $this->pdtaChunks[$subId] = substr($listContent, $offset + 8, $subSize);
                        $offset += 8 + $subSize;
                        if ($subSize % 2 !== 0) $offset++;
                    }
                }
            } else {
                fseek($this->fp, $size, SEEK_CUR);
            }

            if ($size % 2 !== 0) fseek($this->fp, 1, SEEK_CUR);
        }

        $requiredChunks = ['phdr', 'pbag', 'pgen', 'inst', 'ibag', 'igen', 'shdr'];
        foreach ($requiredChunks as $chunk) {
            if (!isset($this->pdtaChunks[$chunk])) {
                throw new \Exception("Error: Chunk '{$chunk}' not found within 'pdta'. The SF2 file may be incomplete or corrupted.");
            }
        }
        if ($this->smplOffset === 0) {
            throw new \Exception("Error: Chunk 'sdta' (sample data) not found.");
        }
    }

    private function parsePdtaSubChunks()
    {
        $this->shdr_list = $this->parseStructArray($this->pdtaChunks['shdr'], 46);
        $this->inst_list = $this->parseStructArray($this->pdtaChunks['inst'], 22);
        $this->phdr_list = $this->parseStructArray($this->pdtaChunks['phdr'], 38);

        $this->log("Successfully read " . count($this->phdr_list) . " Presets, " . count($this->inst_list) . " Instruments, " . count($this->shdr_list) . " Samples.\n");
    }

    /**
     * @param string $data
     * @param int $struct_size
     * @return array
     */
    private function parseStructArray($data, $struct_size)
    {
        $items = [];
        for ($i = 0; $i <= strlen($data) - $struct_size; $i += $struct_size) {
            $items[] = substr($data, $i, $struct_size);
        }
        return $items;
    }

    private function processPresetsAndGeneratePatches()
    {
        $toneDir = $this->outputDir . "/tone";
        $drumDir = $this->outputDir . "/drum";
        if (!is_dir($toneDir)) mkdir($toneDir, 0777, true);
        if (!is_dir($drumDir)) mkdir($drumDir, 0777, true);

        $numPbagEntries = (int)(strlen($this->pdtaChunks['pbag']) / 4);
        $numIbagEntries = (int)(strlen($this->pdtaChunks['ibag']) / 4);

        // Clear the map for each conversion run
        $this->timidityMap = [];

        foreach ($this->phdr_list as $pIdx => $p) {
            $presetName = rtrim(substr($p, 0, 20), "\0");
            $program = unpack('v', substr($p, 20, 2))[1];
            $bank = unpack('v', substr($p, 22, 2))[1];
            $pbag_start_idx = unpack('v', substr($p, 24, 2))[1];

            $isDrum = ($bank == 128);
            if ($bank != 0 && !$isDrum) continue;

            $samplesForPatch = [];
            
            $pbag_end_idx = isset($this->phdr_list[$pIdx + 1]) 
                ? unpack('v', substr($this->phdr_list[$pIdx + 1], 24, 2))[1] 
                : $numPbagEntries - 1;

            for ($i = $pbag_start_idx; $i < $pbag_end_idx; $i++) {
                $pgen_start_idx = unpack('v', substr($this->pdtaChunks['pbag'], $i * 4, 2))[1];
                
                $nextPbagOffset = ($i + 1) * 4;
                $pgen_end_idx = ($nextPbagOffset < strlen($this->pdtaChunks['pbag']))
                    ? unpack('v', substr($this->pdtaChunks['pbag'], $nextPbagOffset, 2))[1]
                    : (int)(strlen($this->pdtaChunks['pgen']) / 4);

                // Default key range for the preset zone
                $p_keyRangeLow = 0;
                $p_keyRangeHigh = 127;

                for ($j = $pgen_start_idx; $j < $pgen_end_idx; $j++) {
                    $gen_id = unpack('v', substr($this->pdtaChunks['pgen'], $j * 4, 2))[1];
                    
                    if ($gen_id == 43) { // keyRange for preset zone
                        $p_keyRangeLow = unpack('C', substr($this->pdtaChunks['pgen'], $j * 4 + 2, 1))[1];
                        $p_keyRangeHigh = unpack('C', substr($this->pdtaChunks['pgen'], $j * 4 + 3, 1))[1];
                    }

                    if ($gen_id == 41) { // instrument generator
                        $inst_id = unpack('v', substr($this->pdtaChunks['pgen'], $j * 4 + 2, 2))[1];
                        if (!isset($this->inst_list[$inst_id])) continue;

                        $ibag_start_idx = unpack('v', substr($this->inst_list[$inst_id], 20, 2))[1];
                        
                        $ibag_end_idx = isset($this->inst_list[$inst_id + 1]) 
                            ? unpack('v', substr($this->inst_list[$inst_id + 1], 20, 2))[1] 
                            : $numIbagEntries - 1;

                        for ($k = $ibag_start_idx; $k < $ibag_end_idx; $k++) {
                            $igen_start_idx = unpack('v', substr($this->pdtaChunks['ibag'], $k * 4, 2))[1];
                            
                            $nextIbagOffset = ($k + 1) * 4;
                            $igen_end_idx = ($nextIbagOffset < strlen($this->pdtaChunks['ibag']))
                                ? unpack('v', substr($this->pdtaChunks['ibag'], $nextIbagOffset, 2))[1]
                                : (int)(strlen($this->pdtaChunks['igen']) / 4);

                            for ($l = $igen_start_idx; $l < $igen_end_idx; $l++) {
                                $igen_id = unpack('v', substr($this->pdtaChunks['igen'], $l * 4, 2))[1];
                                
                                if ($igen_id == 53) { // sampleID generator
                                    $sample_id = unpack('v', substr($this->pdtaChunks['igen'], $l * 4 + 2, 2))[1];
                                    if (isset($this->shdr_list[$sample_id]) && !in_array($this->shdr_list[$sample_id], $samplesForPatch, true)) {
                                        $samplesForPatch[] = $this->shdr_list[$sample_id];
                                    }
                                }
                            }
                        }
                    }
                }
            }

            if (empty($samplesForPatch)) continue;

            $patBody = '';
            $validSamplesCount = 0;

            foreach ($samplesForPatch as $s_chunk) {
                $s_name = rtrim(substr($s_chunk, 0, 20), "\0");
                $s_start = unpack('V', substr($s_chunk, 20, 4))[1];
                $s_end = unpack('V', substr($s_chunk, 24, 4))[1];
                $s_loop_start = unpack('V', substr($s_chunk, 28, 4))[1];
                $s_loop_end = unpack('V', substr($s_chunk, 32, 4))[1];
                $s_rate = unpack('V', substr($s_chunk, 36, 4))[1];
                $s_pitch = ord(substr($s_chunk, 40, 1)); // byOriginalPitch
                $s_pitch_correction = unpack('c', substr($s_chunk, 41, 1))[1]; // chPitchCorrection (signed char)
                $s_type = unpack('v', substr($s_chunk, 44, 2))[1];

                if (($s_type & 0x7FFF) !== 1 && ($s_type & 0x7FFF) !== 4) continue;

                $pcmLenBytes = ($s_end - $s_start) * 2;
                if ($pcmLenBytes <= 0) continue;

                fseek($this->fp, $this->smplOffset + ($s_start * 2));
                $rawPcm = fread($this->fp, $pcmLenBytes);
                if (strlen($rawPcm) == 0) continue;

                // CRITICAL FIX: Explicitly enforce little-endian for sample data.
                // Read each 16-bit sample and re-pack it to ensure correct byte order,
                // regardless of the server's architecture.
                $currentPcm = '';
                $numSamples = $pcmLenBytes / 2;
                for ($j = 0; $j < $numSamples; $j++) {
                    // 's' is signed 16-bit, unpack assumes machine-endian. 'v' forces little-endian pack.
                    $currentPcm .= pack('v', unpack('s', substr($rawPcm, $j * 2, 2))[1]);
                }

                $loopStartByte = ($s_loop_start - $s_start) * 2;
                $loopEndByte = ($s_loop_end - $s_start) * 2;

                // Correct root frequency calculation including pitch correction (in cents)
                $cents = $s_pitch_correction;
                $midiNoteWithCents = $s_pitch + ($cents / 100.0);
                $rootFreqHz = round(440 * pow(2, ($midiNoteWithCents - 69) / 12));

                // CRITICAL FIX #2: Normalize the sample rate based on the root frequency.
                // TiMidity relies on the sample_rate field to determine the base pitch (C4).
                // We adjust the sample rate so that the original pitch of the sample
                // will sound correct when played back as a C4 note.
                $adjustedSampleRate = round($s_rate * $rootFreqHz / 261.625565); // 261.62... Hz is C4

                $modes = 0x01; // 16-bit, signed
                if ($loopStartByte < $loopEndByte) {
                    $modes |= 0x04; // Looping
                    $modes |= 0x40; // Sustain
                }

                $waveHeader = str_pad(substr($s_name, 0, 7), 7, "\0");
                $waveHeader .= pack('C', 0);
                $waveHeader .= pack('V', $pcmLenBytes);
                $waveHeader .= pack('V', $loopStartByte);
                $waveHeader .= pack('V', $loopEndByte);
                $waveHeader .= pack('v', $adjustedSampleRate);
                $waveHeader .= pack('V', 0);
                $waveHeader .= pack('V', 2000000);
                $waveHeader .= pack('V', $rootFreqHz);
                $waveHeader .= pack('v', 0);
                $waveHeader .= pack('C', 8);
                $waveHeader .= pack('CCCCCC', 63, 63, 63, 63, 63, 63);
                $waveHeader .= pack('CCCCCC', 0, 0, 0, 0, 0, 0);
                $waveHeader .= str_repeat("\0", 6);
                $waveHeader .= pack('C', $modes);
                $waveHeader .= str_repeat("\0", 40);

                $patBody .= $waveHeader . $currentPcm;
                $validSamplesCount++;
            }

            if ($validSamplesCount === 0) continue;

            $header = "GF1PATCH110\0";
            $header .= str_pad("ID#000002\0", 10, "\0");
            $header .= str_pad("PHP SF2->PAT", 60, "\0");
            $header .= str_repeat("\0", 116);
            $header .= pack('C', $validSamplesCount);
            $header .= str_repeat("\0", 40);

            $patContent = $header . $patBody;

            $typeFolder = $isDrum ? 'drum' : 'tone';
            $targetDir = ($isDrum ? $drumDir : $toneDir);
            $formattedMidiNum = sprintf("%03d", $program);
            $cleanName = preg_replace('/[^a-zA-Z0-9_\-]/', '_', $presetName);
            $outFileName = "{$formattedMidiNum}_" . strtolower($cleanName) . '.pat';
            $outPath = $targetDir . '/' . $outFileName;
            
            // This needs to be an array of arrays to support key-splits (multiple .pat per program)
            $this->timidityMap[$typeFolder][$program][] = [
                'path' => "{$typeFolder}/{$outFileName}",
                'low' => 0, // Default to full range since we are not splitting yet
                'high' => 127
            ];

            // Save to database if project ID is set
            if ($this->db && $this->projectId) {
                $this->db->addPatchToProject($this->projectId, "{$typeFolder}/{$outFileName}", $typeFolder, $program, $bank, $presetName);
            }

            $this->log(sprintf("Bank %3d | [%-4s] | Program %03d: %s", $bank, strtoupper($typeFolder), $program, $outFileName));

            file_put_contents($outPath, $patContent);
            $this->convertedCount++;
        }
    }

    private function writeTimidityConfig()
    {
        $cfgContent = "# Auto-generated mapping\n";
        $cfgContent .= "dir .\n\n";

        $cfgContent .= "# BANK 0 (Melodic)\n";
        $cfgContent .= "bank 0\n\n";
        if (isset($this->timidityMap['tone'])) {
            $sortedPrograms = $this->timidityMap['tone'];
            ksort($sortedPrograms);
            foreach ($sortedPrograms as $progNum => $mappings) {
                foreach ($mappings as $map) {
                    $cfgContent .= sprintf("%+3d %s\n", $progNum, $map['path']);
                }
            }
        }

        $cfgContent .= "\n\n# DRUMSET 0 (Percussion)\n";
        $cfgContent .= "drumset 0\n\n";
        if (isset($this->timidityMap['drum'])) {
            $sortedDrums = $this->timidityMap['drum'];
            ksort($sortedDrums);
            foreach ($sortedDrums as $progNum => $mappings) {
                // Drums usually map 1:1, but we use the same logic for consistency
                $cfgContent .= sprintf("%-3d %s\n", $progNum, $mappings[0]['path']);
            }
        }

        file_put_contents($this->outputDir . '/timidity.cfg', $cfgContent);
    }
}
