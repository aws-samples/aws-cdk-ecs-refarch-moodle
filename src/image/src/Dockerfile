FROM bitnami/moodle:4.0.5
RUN apt-get update -y

# Install PHP Redis
RUN apt-get install -y autoconf wget build-essential && \
    wget https://pecl.php.net/get/redis-5.3.7.tgz && \
    tar xzf redis-5.3.7.tgz && \
    cd redis-5.3.7 && \
    phpize && \
    ./configure && \
    make && \
    make install && \
    echo "extension=redis.so" >> /opt/bitnami/php/etc/php.ini && \
    apt-get purge --autoremove -y autoconf wget build-essential && \
    cd .. && \
    rm redis-5.3.7.tgz && \
    rm -rf redis-5.3.7

# Copy the updated libmoodle.sh
COPY ./libmoodle.sh /opt/bitnami/scripts/libmoodle.sh