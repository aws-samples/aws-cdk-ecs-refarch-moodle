FROM bitnami/moodle:4.5
RUN apt-get update -y

# Install PHP Redis and gosu
RUN apt-get install -y autoconf wget build-essential gosu
RUN wget https://pecl.php.net/get/redis-6.2.0.tgz && \
    tar xzf redis-6.2.0.tgz && \
    cd redis-6.2.0 && \
    phpize && \
    ./configure && \
    make && \
    make install && \
    echo "extension=redis.so" >> /opt/bitnami/php/etc/php.ini && \
    apt-get purge --autoremove -y autoconf wget build-essential && \
    cd .. && \
    rm redis-6.2.0.tgz && \
    rm -rf redis-6.2.0

# Copy the updated libmoodle.sh
COPY ./libmoodle.sh /opt/bitnami/scripts/libmoodle.sh