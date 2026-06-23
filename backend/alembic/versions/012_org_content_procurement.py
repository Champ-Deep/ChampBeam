"""Org/RBAC mirror, shared content library, and domain procurement columns.

Adds:
- ``organizations`` + ``organization_memberships`` (local mirror of Clerk Orgs).
- ``content_items`` + ``content_shares`` (the shared content library and the
  per-member share bridge that lets analytics consolidate by content_id).
- procurement columns on ``domains`` for domains bought via Cloudflare Registrar.

Idempotent via IF NOT EXISTS guards, matching the defensive style of 007/008.

Revision ID: 012_org_content_procurement
Revises: 011_file_project_id
"""

from alembic import op


revision = "012_org_content_procurement"
down_revision = "011_file_project_id"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # === organizations ==================================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS organizations (
            id UUID NOT NULL PRIMARY KEY,
            clerk_org_id VARCHAR(255) NOT NULL,
            name VARCHAR(255),
            slug VARCHAR(255),
            created_at TIMESTAMP NOT NULL DEFAULT now(),
            updated_at TIMESTAMP DEFAULT now()
        )
    """)
    op.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_clerk_org_id ON organizations (clerk_org_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_organizations_slug ON organizations (slug)")

    # === organization_memberships =======================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS organization_memberships (
            id UUID NOT NULL PRIMARY KEY,
            organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            role VARCHAR(32) NOT NULL DEFAULT 'member',
            clerk_membership_id VARCHAR(255),
            created_at TIMESTAMP NOT NULL DEFAULT now(),
            updated_at TIMESTAMP DEFAULT now(),
            CONSTRAINT uq_org_membership_org_user UNIQUE (organization_id, user_id)
        )
    """)
    op.execute("CREATE INDEX IF NOT EXISTS idx_org_memberships_org ON organization_memberships (organization_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_org_memberships_user ON organization_memberships (user_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_org_memberships_clerk ON organization_memberships (clerk_membership_id)")

    # === content_items ==================================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS content_items (
            id UUID NOT NULL PRIMARY KEY,
            organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
            title VARCHAR(255) NOT NULL,
            description TEXT,
            kind VARCHAR(16) NOT NULL,
            canonical_url TEXT,
            file_id UUID REFERENCES file_assets(id) ON DELETE SET NULL,
            is_archived BOOLEAN NOT NULL DEFAULT false,
            created_at TIMESTAMP NOT NULL DEFAULT now(),
            updated_at TIMESTAMP DEFAULT now()
        )
    """)
    op.execute("CREATE INDEX IF NOT EXISTS idx_content_items_org ON content_items (organization_id)")

    # === content_shares =================================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS content_shares (
            id UUID NOT NULL PRIMARY KEY,
            content_id UUID NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
            organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            shared_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            link_id UUID REFERENCES link_clicks(id) ON DELETE SET NULL,
            file_id UUID REFERENCES file_assets(id) ON DELETE SET NULL,
            domain_id UUID REFERENCES domains(id) ON DELETE SET NULL,
            created_at TIMESTAMP NOT NULL DEFAULT now()
        )
    """)
    op.execute("CREATE INDEX IF NOT EXISTS idx_content_shares_content ON content_shares (content_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_content_shares_org ON content_shares (organization_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_content_shares_user ON content_shares (shared_by_user_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_content_shares_link ON content_shares (link_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_content_shares_file ON content_shares (file_id)")

    # === domains procurement columns ====================================
    op.execute("ALTER TABLE domains ADD COLUMN IF NOT EXISTS registrar VARCHAR(32)")
    op.execute("ALTER TABLE domains ADD COLUMN IF NOT EXISTS registration_status VARCHAR(32)")
    op.execute("ALTER TABLE domains ADD COLUMN IF NOT EXISTS auto_renew BOOLEAN NOT NULL DEFAULT false")
    op.execute("ALTER TABLE domains ADD COLUMN IF NOT EXISTS registration_price VARCHAR(32)")
    op.execute("ALTER TABLE domains ADD COLUMN IF NOT EXISTS domain_expires_at TIMESTAMP")


def downgrade() -> None:
    op.execute("ALTER TABLE domains DROP COLUMN IF EXISTS domain_expires_at")
    op.execute("ALTER TABLE domains DROP COLUMN IF EXISTS registration_price")
    op.execute("ALTER TABLE domains DROP COLUMN IF EXISTS auto_renew")
    op.execute("ALTER TABLE domains DROP COLUMN IF EXISTS registration_status")
    op.execute("ALTER TABLE domains DROP COLUMN IF EXISTS registrar")

    op.execute("DROP TABLE IF EXISTS content_shares")
    op.execute("DROP TABLE IF EXISTS content_items")
    op.execute("DROP TABLE IF EXISTS organization_memberships")
    op.execute("DROP TABLE IF EXISTS organizations")
