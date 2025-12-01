FROM moodlehq/moodle-php-apache:8.4 

# Set Apache environment variables
ENV APACHE_DOCUMENT_ROOT=/var/www/html
ENV APACHE_RUN_USER=www-data
ENV APACHE_RUN_GROUP=www-data
ENV APACHE_LOG_DIR=/var/log/apache2
ENV APACHE_PID_FILE=/var/run/apache2/apache2.pid
ENV APACHE_RUN_DIR=/var/run/apache2
ENV APACHE_LOCK_DIR=/var/lock/apache2

# Install packages, download Moodle, and configure Apache in one layer
RUN apt-get update -y && \
    apt-get install -y wget cron sudo logrotate && \
    apt-get clean

# Configure Apache to listen on port 8080
RUN sed -i 's/Listen 80/Listen 8080/' /etc/apache2/ports.conf

# Download and extract Moodle
RUN TEMP_DIR=$(mktemp -d) && \
    cd ${TEMP_DIR} && \
    wget -q https://download.moodle.org/download.php/direct/stable501/moodle-latest-501.tgz && \
    tar -xzf moodle-latest-501.tgz && \
    mv moodle/ /opt/ && \
    rm -rf ${TEMP_DIR}

# Copy scripts and set permissions
COPY --chmod=755 ./moodle-init.sh /usr/local/bin/moodle-init.sh
COPY --chown=www-data:www-data --chmod=755 ./moodle-cron-wrapper.sh /usr/local/bin/moodle-cron-wrapper.sh

# Configure logging and cron 
RUN mkdir -p /var/log/moodle && \
    touch /var/log/moodle/cron.log && \
    chown -R www-data:www-data /var/log/moodle && \
    # Configure logrotate
    echo '/var/log/moodle/cron.log {\n\
    size 10M\n\
    rotate 1\n\
    missingok\n\
    notifempty\n\
    compress\n\
    delaycompress\n\
    copytruncate\n\
    su www-data www-data\n\
}' > /etc/logrotate.d/moodle-cron && \
    # Setup crontabs
    echo '* * * * * /usr/local/bin/moodle-cron-wrapper.sh >> /var/log/moodle/cron.log 2>&1' | crontab -u www-data - && \
    echo '0 * * * * /usr/sbin/logrotate /etc/logrotate.d/moodle-cron' | crontab -u root -

# Copy and configure Apache VirtualHost for Moodle
COPY ./moodle-site.conf /etc/apache2/sites-available/moodle.conf
RUN a2dissite 000-default.conf && \
    a2ensite moodle.conf && \
    a2enmod rewrite headers

# Copy PHP configuration for Moodle
COPY ./moodle-php.ini /usr/local/etc/php/conf.d/moodle.ini

# Remove base image moodledata directory
RUN rm -rf /var/www/moodledata

# Forward Apache logs to Docker log collector
RUN ln -sf /dev/stdout /var/log/apache2/access.log && \
    ln -sf /dev/stderr /var/log/apache2/error.log

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/moodle-init.sh"]