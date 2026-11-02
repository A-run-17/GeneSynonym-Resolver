FROM php:8.3-fpm
RUN apt-get update \
 && apt-get install -y libpq-dev libicu-dev \
 && docker-php-ext-install pdo pdo_pgsql intl \
 && rm -rf /var/lib/apt/lists/*
