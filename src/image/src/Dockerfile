# FROM bitnami/moodle:4.5
FROM moodlehq/moodle-php-apache:8.3

# Set Apache environment variables
ENV APACHE_DOCUMENT_ROOT=/var/www/html
ENV APACHE_RUN_USER=www-data
ENV APACHE_RUN_GROUP=www-data
ENV APACHE_LOG_DIR=/var/log/apache2
ENV APACHE_PID_FILE=/var/run/apache2/apache2.pid
ENV APACHE_RUN_DIR=/var/run/apache2
ENV APACHE_LOCK_DIR=/var/lock/apache2

RUN apt-get update -y

# Install required packages
RUN apt-get install -y autoconf wget build-essential gosu curl procps net-tools

RUN TEMP_DIR=$(mktemp -d) && \
    cd ${TEMP_DIR} && \
    wget https://download.moodle.org/download.php/direct/stable501/moodle-latest-501.tgz && \
    tar -xzf moodle-latest-501.tgz && \
    mv moodle/ /opt/ && \
    rm -rf ${TEMP_DIR}

# Copy the initialization script
COPY ./moodle-init.sh /usr/local/bin/moodle-init.sh
RUN chmod +x /usr/local/bin/moodle-init.sh

# Copy and configure Apache VirtualHost for Moodle
COPY ./moodle-site.conf /etc/apache2/sites-available/moodle.conf
RUN a2dissite 000-default.conf && \
    a2ensite moodle.conf && \
    a2enmod rewrite headers

# Copy PHP configuration for Moodle
COPY ./moodle-php.ini /usr/local/etc/php/conf.d/moodle.ini

# Forward Apache logs to Docker log collector
RUN ln -sf /dev/stdout /var/log/apache2/access.log && \
    ln -sf /dev/stderr /var/log/apache2/error.log

# Set the entrypoint
ENTRYPOINT ["/usr/local/bin/moodle-init.sh"]