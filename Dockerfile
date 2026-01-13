FROM node:22

# Install dependencies for native modules and runtime
RUN apt-get update && apt-get install -y \
    build-essential \
    python3 \
    make \
    g++ \
    cmake \
    libtool \
    autoconf \
    automake \
    libsodium-dev \
    libopus-dev \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (force to skip Windows-only packages)
RUN npm install --force

# Debug: Show what prism-media exports
RUN node -e "const prism = require('prism-media'); console.log('prism keys:', Object.keys(prism)); console.log('prism.opus keys:', Object.keys(prism.opus || {}));"

# Copy source files
COPY tsconfig.json ./
COPY app.ts ./
COPY util/ ./util/

# Build TypeScript
RUN npm run build

# Copy media files
COPY media/ ./media/

# Create recordings directory
RUN mkdir -p /app/recordings && chown node:node /app/recordings

# Declare volume for recordings
VOLUME /app/recordings

# Prune dev dependencies
RUN npm prune --omit=dev --force

# Run as non-root user
USER node

CMD ["node", "dist/app.js"]
