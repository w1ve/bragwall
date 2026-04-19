FROM node:22-alpine

# canvas native deps + fonts
RUN apk add --no-cache \
    cairo-dev \
    pango-dev \
    jpeg-dev \
    giflib-dev \
    librsvg-dev \
    pixman-dev \
    python3 \
    make \
    g++ \
    ttf-dejavu

WORKDIR /app
COPY package.json .
RUN npm install

COPY badge.js .

EXPOSE 3002
ENV PORT=3002

CMD ["node", "badge.js"]
