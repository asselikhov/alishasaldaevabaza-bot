FROM node:22.16.0

# Установка системных зависимостей для canvas
RUN apt-get update && apt-get install -y \
  libcairo2-dev \
  libjpeg-dev \
  libpng-dev \
  libpango1.0-dev \
  libgif-dev \
  build-essential \
  && rm -rf /var/lib/apt/lists/*

# Установка рабочей директории
WORKDIR /opt/render/project/src

# Копирование package.json и установка зависимостей
COPY package.json .
RUN npm install

# Копирование остального кода приложения
COPY . .

# Открытие порта (если требуется, настройте по необходимости)
EXPOSE 3000

# Запуск приложения
CMD ["npm", "start"]