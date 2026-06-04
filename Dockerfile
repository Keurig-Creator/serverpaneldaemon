FROM node:20

RUN apt-get update && apt-get install -y docker.io

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["node", "src/api.js"]