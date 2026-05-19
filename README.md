# ChampUTM - Smart UTM Link Generator

**ChampUTM** is a powerful, user-friendly UTM tracking and analytics platform that helps marketers create, manage, and analyze campaign links with ease.

## Features

### 🔗 Public Link Generator
- Generate UTM-tagged links instantly without signing up
- Clean, intuitive interface
- Recent links saved locally

### 📋 Presets (Account Required)
- Save reusable UTM templates
- Quick-apply presets to any URL
- Team-wide preset sharing (coming soon)

### 📊 Analytics Dashboard (Account Required)
- Track click performance across all your links
- Breakdown by source, medium, campaign
- Visual charts and insights

### 📦 Bulk Generator (Account Required)
- Upload CSV with multiple URLs
- Apply presets or custom UTM parameters
- Download tracked URLs instantly

### 🔐 Account Security
- Email + password authentication with JWT
- "Forgot password?" 2-step reset flow with Resend
- Authenticated "Change password" with old-session invalidation
- Tokens stored bcrypt-hashed; reset links single-use and time-limited

## Tech Stack

**Frontend:**
- React 18 with TypeScript
- Vite for fast development
- TailwindCSS for styling
- React Query for data fetching
- Recharts for analytics visualizations

**Backend:**
- FastAPI (Python 3.11+)
- PostgreSQL for data storage
- Redis for caching
- SQLAlchemy ORM
- Alembic for migrations

## Quick Start

### Prerequisites
- Node.js 18+
- Python 3.11+
- PostgreSQL 14+
- Redis 7+

### Frontend Development
```bash
cd frontend
npm install
npm run dev
```

### Backend Development
```bash
cd backend
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
pip install -r requirements.txt
alembic upgrade head
uvicorn app.main:app --reload
```

## Project Structure

```
champutm/
├── frontend/          # React application
│   ├── src/
│   │   ├── api/       # API client functions
│   │   ├── components/# Reusable UI components
│   │   ├── pages/     # Page components
│   │   └── hooks/     # Custom React hooks
│   └── package.json
│
├── backend/           # FastAPI application
│   ├── app/
│   │   ├── api/       # API endpoints
│   │   ├── models/    # Database models
│   │   ├── services/  # Business logic
│   │   └── core/      # Config and security
│   └── requirements.txt
│
└── README.md
```

## Environment Variables

### Frontend (.env)
```env
VITE_API_URL=http://localhost:8000
```

### Backend (.env)
```env
DATABASE_URL=postgresql://user:password@localhost/champutm
REDIS_URL=redis://localhost:6379
JWT_SECRET_KEY=your-secret-key-here
JWT_ALGORITHM=HS256
JWT_EXPIRE_MINUTES=1440

# Resend (password reset emails). If unset, the backend logs the attempt
# and returns the same generic response — useful for local dev where
# you may not want to wire up real email delivery.
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxx
RESEND_FROM_EMAIL=ChampUTM <no-reply@yourdomain.com>

# Public URL the reset link points to. Must match the frontend deploy.
FRONTEND_URL=https://app.yourdomain.com

# How long a password reset link stays valid (minutes).
PASSWORD_RESET_TOKEN_TTL_MINUTES=30
```

### Password reset flow

The forgot-password endpoint is decoupled into a two-step workflow.
Resend acts solely as the email transport — the backend owns all token
generation, hashing, and lifecycle management.

1. `POST /api/v1/auth/forgot-password` accepts `{ email }`. Always
   returns the same generic message regardless of whether the email is
   registered (prevents user enumeration). For known users it
   generates a 48-byte URL-safe random token, persists only its
   bcrypt hash with a short expiry, and dispatches the reset email via
   the Resend SDK in a background task. Rate-limited 5/15min per key.
2. `POST /api/v1/auth/reset-password` accepts `{ token, new_password }`.
   Validates the raw token against the stored hash + expiry, hashes
   and saves the new password, stamps `password_changed_at` so any
   previously issued JWT is invalidated, and deletes the token row
   (single-use). Rate-limited 10/15min.

Signed-in users can also rotate their password directly via
`POST /api/v1/auth/change-password` (Settings page in the UI), which
requires the current password and returns a freshly issued JWT so the
caller is not booted by the invalidation rule.

## Deployment

**Frontend:** Vercel
**Backend:** Railway with PostgreSQL + Redis add-ons

## License

MIT License - see LICENSE file for details

## Contributing

Contributions welcome! Please open an issue or PR.

---

Built with ❤️ by the Champ team
