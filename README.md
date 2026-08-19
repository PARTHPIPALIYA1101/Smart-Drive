# 🚀 Smart Drive

**Unified virtual filesystem that pools multiple Google Drive accounts into a single seamless storage layer.**

Smart Drive lets you connect as many Google Drive accounts as you want and treats them as one giant drive. Upload a file and Smart Drive automatically picks the account with the most free space. Need to retire an account? One click migrates everything off it first.

---

## ✨ Features

| Feature | Description |
|---|---|
| **Unified VFS** | Browse, create, rename, move, trash, and restore files/folders across all connected drives from a single file tree |
| **Multi-Account Pooling** | Connect unlimited Google Drive accounts; total capacity = sum of all accounts |
| **Smart Placement** | Uploads are automatically routed to the account with the most available space |
| **Folder Upload Queue** | Drag-and-drop entire folder trees with background queued uploads and progress tracking |
| **File Download & Export** | Download any file; Google Workspace files (Docs, Sheets, Slides, Drawings) are auto-exported to Office / PNG formats |
| **Copy & Move** | Copy files across drives or move them within the virtual tree |
| **Drive Import** | Import existing files from any connected Google Drive account into the virtual filesystem |
| **Search** | Full-text filename search with filters for extension, MIME type, size range, and sort options |
| **Capacity Dashboard** | Real-time unified capacity report across all accounts |
| **Storage Statistics** | Detailed per-account and aggregate storage analytics |
| **Migration Planner** | Plan data migrations between drives before executing them |
| **Drive Retirement** | Safely retire a Google Drive account by migrating all its files to other connected drives first |
| **Crash Recovery** | On startup, automatically reconciles any operations that were interrupted by a crash |
| **Reservation System** | Space reservations prevent over-allocation when multiple uploads run concurrently |
| **Real-Time SSE Events** | Server-Sent Events stream for live UI updates on uploads, migrations, and operations |
| **OAuth 2.0 Flow** | Secure Google OAuth 2.0 with encrypted token storage (AES-256) |
| **Trash Management** | Soft-delete with restore, batch trash/restore, empty trash (with physical deletion from Drive) |

---

## 🏗️ Architecture

```
src/
├── api/              # Fastify REST API server & route definitions
├── application/      # Application services (account management, sync, import, retirement)
├── domain/           # Core domain logic
│   ├── vfs/          #   Virtual Filesystem service
│   ├── capacity/     #   Capacity tracking & reporting
│   ├── transfer/     #   Upload, download, copy & upload queue
│   ├── stats/        #   Storage statistics
│   ├── events/       #   Domain event bus (SSE backbone)
│   └── errors.ts     #   Domain error types
├── infrastructure/   # Cross-cutting concerns
│   └── crypto/       #   AES-256 token encryption
├── persistence/      # Database layer (Drizzle ORM + SQLite)
│   ├── schema/       #   Drizzle table schemas
│   └── repositories/ #   Data access repositories
├── providers/        # Storage provider abstraction
│   ├── google-drive/ #   Google Drive provider + OAuth service
│   └── memory/       #   In-memory provider (testing)
├── search/           # Search service
└── storage/          # Storage orchestration
    ├── planner/      #   Smart placement algorithm
    ├── migration/    #   Migration planner & executor
    ├── recovery/     #   Crash recovery engine
    └── reservation/  #   Space reservation manager
```

**Tech Stack:**
- **Runtime:** Node.js + TypeScript
- **Framework:** Fastify 5
- **Database:** SQLite via better-sqlite3 + Drizzle ORM
- **Auth:** Google OAuth 2.0 with AES-256 encrypted token storage
- **Frontend:** Vanilla HTML/CSS/JS (served as static files)
- **Testing:** Vitest

---

## 📦 Prerequisites

- **Node.js** ≥ 18
- **npm** ≥ 9
- A **Google Cloud** project with the **Google Drive API** enabled
- **OAuth 2.0 Client ID** credentials (Web application type)

---

## ⚡ Quick Start

### 1. Clone & Install

```bash
git clone <your-repo-url>
cd smart-drive
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your actual values:

```env
PORT=3000
HOST=127.0.0.1
DATABASE_URL=./smart_drive.db
ENCRYPTION_KEY=<your-64-char-hex-key>

# Google OAuth 2.0 (from Google Cloud Console → APIs & Services → Credentials)
GOOGLE_CLIENT_ID=<your-client-id>.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=<your-client-secret>
GOOGLE_REDIRECT_URI=http://localhost:3000/oauth2callback
```

> **Generate an encryption key:**
> ```bash
> node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
> ```

### 3. Set Up Google Cloud OAuth

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project (or select an existing one)
3. Enable the **Google Drive API**
4. Go to **APIs & Services → Credentials**
5. Create an **OAuth 2.0 Client ID** (Application type: **Web application**)
6. Add `http://localhost:3000/oauth2callback` as an **Authorized redirect URI**
7. Copy the **Client ID** and **Client Secret** into your `.env`

### 4. Run Database Migrations

```bash
npm run db:migrate
```

### 5. Start the Server

```bash
# Development (with hot-reload)
npm run dev

# Production
npm run build
npm start
```

The server starts at **http://localhost:3000** 🎉

### 6. Connect a Google Drive

Open the web UI and click **"Connect Google Drive"** — you'll be redirected through Google's OAuth flow. Once authorized, the account appears in your dashboard and its storage is pooled automatically.

---

## 📡 API Reference

### Virtual Filesystem

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/vfs/tree` | Get the full virtual file tree |
| `GET` | `/api/vfs/children?parentId=` | List children of a folder |
| `GET` | `/api/vfs/nodes/:id` | Get a single node by ID |
| `POST` | `/api/vfs/folders` | Create a folder |
| `POST` | `/api/vfs/folders/ensure-path` | Create nested folder path |
| `PUT` | `/api/vfs/nodes/:id/rename` | Rename a file or folder |
| `PUT` | `/api/vfs/nodes/:id/move` | Move a node to a new parent |
| `DELETE` | `/api/vfs/nodes/:id/trash` | Soft-delete (trash) a node |
| `POST` | `/api/vfs/nodes/:id/restore` | Restore from trash |
| `POST` | `/api/vfs/trash/batch` | Batch trash nodes |
| `POST` | `/api/vfs/restore/batch` | Batch restore nodes |
| `GET` | `/api/vfs/trash` | List all trashed items |
| `DELETE` | `/api/vfs/trash/empty` | Permanently delete all trash |
| `DELETE` | `/api/vfs/nodes/:id/permanent` | Permanently delete a single node |
| `POST` | `/api/vfs/permanent/batch` | Batch permanent delete |

### Transfers

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/transfer/upload` | Upload a file (multipart) |
| `POST` | `/api/transfer/folder/plan` | Plan a folder upload |
| `POST` | `/api/transfer/folder/queue` | Queue a folder upload (background) |
| `POST` | `/api/transfer/batch/cancel` | Cancel a queued batch |
| `GET` | `/api/transfer/download/:id` | Download a file |
| `POST` | `/api/transfer/copy` | Copy a file |

### Accounts

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/accounts/auth-url` | Get Google OAuth URL |
| `GET` | `/api/accounts` | List connected accounts |
| `POST` | `/api/accounts/connect` | Connect an account via auth code |
| `POST` | `/api/accounts/:id/lock` | Lock/unlock migration for an account |
| `POST` | `/api/accounts/:id/import` | Import files from a Drive account |
| `POST` | `/api/accounts/import-all` | Import files from all accounts |
| `POST` | `/api/accounts/:id/retire` | Retire a Drive account |

### Search, Stats & Operations

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/search` | Search files (query, extension, size, etc.) |
| `GET` | `/api/search/properties/:id` | Get detailed file properties |
| `GET` | `/api/capacity` | Unified capacity report |
| `GET` | `/api/stats` | Storage statistics |
| `POST` | `/api/capacity/sync` | Sync quota from all accounts |
| `GET` | `/api/operations/active` | Active operations & upload batches |
| `GET` | `/api/operations/recent` | Recent operations history |
| `GET` | `/api/operations/:id/progress` | SSE progress stream for an operation |
| `GET` | `/api/events` | SSE stream for all real-time events |

---

## 🧪 Testing

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch
```

---

## 🛠️ Scripts

| Script | Command | Description |
|---|---|---|
| `dev` | `npm run dev` | Start dev server with hot-reload (tsx watch) |
| `build` | `npm run build` | Compile TypeScript to `dist/` |
| `start` | `npm start` | Run compiled production build |
| `test` | `npm test` | Run test suite (Vitest) |
| `test:watch` | `npm run test:watch` | Run tests in watch mode |
| `db:generate` | `npm run db:generate` | Generate Drizzle migration files |
| `db:migrate` | `npm run db:migrate` | Apply database migrations |

---

## 🔒 Security

- **OAuth tokens** are encrypted at rest using **AES-256** before being stored in the database
- **`.env`** is gitignored — your Client ID, Client Secret, and encryption key never touch version control
- **`.env.example`** is committed with placeholder values as a setup template
- All database files (`*.db`, `*.db-wal`, `*.db-shm`) are gitignored

> ⚠️ **Never commit your `.env` file.** If you accidentally do, rotate your Google OAuth credentials and encryption key immediately.

---