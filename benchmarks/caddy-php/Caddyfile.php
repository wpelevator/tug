{
    auto_https off
    servers {
        protocols h1
    }
}
https://benchmark:443 {
    tls /certs/cert.pem /certs/key.pem {
        protocols tls1.3 tls1.3
    }
    root * /app
    php_fastcgi php:9000
    file_server
}
