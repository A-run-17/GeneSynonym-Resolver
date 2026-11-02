<?php
declare(strict_types=1);

function db(): PDO
{
    static $pdo = null;               // remember the connection between calls
    if ($pdo === null) {
        $dsn = sprintf(
            'pgsql:host=%s;port=5432;dbname=%s',
            getenv('DB_HOST') ?: 'db',
            getenv('POSTGRES_DB') ?: 'resolver'
        );
        $pdo = new PDO($dsn, getenv('WEB_DB_USER'), getenv('WEB_DB_PASSWORD'), [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
        ]);
    }
    return $pdo;
}
