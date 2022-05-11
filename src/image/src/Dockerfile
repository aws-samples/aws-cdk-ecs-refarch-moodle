FROM bitnami/moodle:3.11.7
RUN apt-get update -y
RUN apt-get install -y \
    autoconf \
    wget \
    build-essential

RUN wget https://pecl.php.net/get/redis-5.3.7.tgz && \
    tar xzf redis-5.3.7.tgz && \
    cd redis-5.3.7 && \
    phpize && \
    ./configure && \
    make && \
    make install && \
    echo "extension=redis.so" >> /opt/bitnami/php/etc/php.ini

RUN apt-get purge --autoremove -y \
    autoconf \
    wget \
    build-essential