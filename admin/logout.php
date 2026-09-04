<?php
declare(strict_types=1);

/**
 * GET task/logout.php — ferme la session du panel et revient à l'accueil.
 */

define('TFH_API', true);
require __DIR__ . '/lib.php';

task_security_headers();

destroy_session($pdo);
task_redirect('index.php');
