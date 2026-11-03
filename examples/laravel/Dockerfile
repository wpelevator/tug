FROM composer:2 AS dependencies
WORKDIR /app
COPY composer.json composer.lock ./
RUN composer install --no-dev --no-scripts --no-autoloader --ignore-platform-reqs
FROM php:8.3-cli
RUN docker-php-ext-install pdo_mysql
COPY uploads.ini /usr/local/etc/php/conf.d/uploads.ini
WORKDIR /app
COPY --from=dependencies /app/vendor ./vendor
COPY . .
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer
RUN composer dump-autoload --no-dev --no-scripts --optimize \
    && composer check-platform-reqs --no-dev \
    && chown -R www-data:www-data storage bootstrap/cache
USER www-data
CMD ["php", "artisan", "serve", "--host=0.0.0.0", "--port=8000"]
