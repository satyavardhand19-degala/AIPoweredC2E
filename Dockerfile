# Use Node.js LTS (matches the version checked earlier)
FROM node:24-slim

# Create app directory
WORKDIR /usr/src/app

# Install system dependencies if needed (none strictly required for now)
# RUN apt-get update && apt-get install -y ...

# Copy package files and install production dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy application source
COPY . .

# Ensure data and uploads directories exist and are writable
RUN mkdir -p data uploads && chmod 777 data uploads

# Expose the server port
EXPOSE 3000

# Default environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

# Start script (will use a process manager or direct node)
# For container, we might want to start both server and worker.
# We'll use a simple shell script or just the server by default.
CMD ["node", "server.mjs"]
