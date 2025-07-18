FROM node:18-alpine

# Force fresh build
ENV BUILDKIT_INLINE_CACHE=0

# Install curl for healthcheck
RUN apk add --no-cache curl

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Expose port
EXPOSE 8080

# Start the application directly with TypeScript
CMD ["npx", "tsx", "index.ts"]