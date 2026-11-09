FROM node:22-alpine
RUN apk add --no-cache cups-client
WORKDIR /app
COPY package.json ./
COPY agent.js ./
COPY lib ./lib
CMD ["node", "agent.js"]
