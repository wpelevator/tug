<?php
header('Content-Type: text/plain');
header('Cache-Control: no-store');
echo (new DateTimeImmutable('now', new DateTimeZone('UTC')))->format('Y-m-d\TH:i:s.u\Z'), "\n";
