import { defineNamespace } from "./types"

export const billing = defineNamespace({
  keys: {
    "billing.review.title": "Review selected plan",
    "billing.review.loading": "Checking workspace and current prices…",
    "billing.review.unavailable": "Plan review is unavailable. Your current access stays unchanged.",
    "billing.review.cancelPrevious": "Cancel previous checkout and review again",
    "billing.review.retry": "Try review again",
    "billing.review.workspaceLabel": "Workspace:",
    "billing.review.currentWorkspace": "Current workspace",
    "billing.review.personal": "Personal workspace",
    "billing.review.team": "Team workspace — shared billing",
    "billing.review.unconfirmed": "Workspace type needs confirmation",
    "billing.review.capacity": "{capacity} capacity",
    "billing.review.annual": "{amount} billed annually.",
    "billing.review.monthly": "{amount} billed monthly.",
    "billing.review.equivalent": "Equivalent to {amount}/month.",
    "billing.review.period": "This plan applies only to this workspace. AI capacity resets every seven days, independently of billing.",
    "billing.review.payHelp": "Continue to Stripe to pay securely. Your plan starts after payment is confirmed.",
    "billing.review.comingSoonHelp": "Paid checkout is coming soon. Reviewing a plan does not change your access or create a subscription.",
    "billing.review.opening": "Opening checkout…",
    "billing.review.continue": "Continue to Stripe",
    "billing.review.comingSoon": "Checkout coming soon",
    "billing.review.close": "Close plan review",
    "billing.review.checkoutUnavailable": "Checkout is unavailable.",
    "billing.review.wrong_scope": "This plan does not match the workspace type. Choose an Individual plan for a personal workspace or a Team plan for a team workspace.",
    "billing.review.scope_unconfirmed": "Contact support to confirm this workspace’s type before choosing a paid plan.",
    "billing.review.existing_billing": "This workspace has existing billing or an agreed allowance. Contact us before changing plans.",
    "billing.review.covered_access": "This workspace has covered access. Contact us before purchasing a subscription.",
    "billing.review.already_subscribed": "This workspace already has a paid plan. Manage it through workspace billing.",
    "billing.review.personal_collaboration_review": "This personal workspace has collaborators. Contact us to confirm the right plan.",
    "billing.selection.unavailable": "Plan selection unavailable",
    "billing.selection.invalid": "This link does not contain a supported plan and billing interval.",
    "billing.selection.compare": "Compare plans",
    "billing.selection.loading": "Loading your account…",
    "billing.selection.title": "Choose a workspace for this plan",
    "billing.selection.description": "Choose the workspace that owns this plan, then review its current price before purchasing.",
    "billing.selection.signInHelp": "Sign in or create an account to keep your selected plan and billing interval.",
    "billing.selection.signIn": "Sign in to review plan",
    "billing.selection.create": "Create an account",
    "billing.selection.continue": "Continue to Aquilla",
    "billing.selection.workspacesLoading": "Loading workspaces…",
    "billing.selection.workspacesUnavailable": "Workspaces are unavailable. Please try again.",
    "billing.selection.retry": "Try workspaces again",
    "billing.selection.noWorkspace": "No workspace grants you billing authority. Create a workspace in Aquilla or ask its owner for access, then return to this link.",
    "billing.selection.reviewFor": "Review for {workspace}",
    "billing.selection.workspaceFallback": "workspace {id}",

    "billing.usage.aiWords": "Agent credits",
    "billing.usage.open": "Billing",
    "billing.usage.words": "credits",
    "billing.loading": "Loading billing…",
    "billing.maintainersOnly": "Billing is visible to organization maintainers.",
    "billing.plan.group": "Plan",
    "billing.plan.current": "Current plan",
    "billing.plan.field": "Field Plan",
    "billing.plan.manage": "Manage",
    "billing.plan.manageHelp": "Update the card, invoices, or cancel in Stripe.",
    "billing.usage.period": "Agent credits this period",
    "billing.usage.label": "Usage",
    "billing.usage.unpaidHelp": "Explore includes a cycle of agent credits. Field Plan checkout is coming soon.",
    "billing.addon.prompt": "Need more credits?",
    "billing.contact.prompt": "Talk to us",
    "billing.contact.email": "Email support",
    "billing.settings.description": "Manage this organization. Personal preferences moved to",
    "billing.settings.preferences": "Preferences",
    "billing.settings.identity": "Identity",
    "billing.settings.security": "Security",
    "billing.settings.billing": "Billing & usage",
    "billing.settings.providers": "AI provider keys",
    "billing.settings.peopleProjects": "People & Projects",
    "billing.settings.teams": "Teams",
    "billing.settings.archived": "Archived projects",
  },
  context: {
    keys: {
  "billing.review.title": {
    "description": "Billing plan review or workspace selection text."
  },
  "billing.review.loading": {
    "description": "Billing plan review or workspace selection text."
  },
  "billing.review.unavailable": {
    "description": "Billing plan review or workspace selection text."
  },
  "billing.review.cancelPrevious": {
    "description": "Explicitly expires an unfinished Stripe checkout and reviews the new choice. Never cancels an active subscription."
  },
  "billing.review.retry": {
    "description": "Billing plan review or workspace selection text."
  },
  "billing.review.workspaceLabel": {
    "description": "Billing plan review or workspace selection text."
  },
  "billing.review.currentWorkspace": {
    "description": "Billing plan review or workspace selection text."
  },
  "billing.review.personal": {
    "description": "Billing plan review or workspace selection text."
  },
  "billing.review.team": {
    "description": "Billing plan review or workspace selection text."
  },
  "billing.review.unconfirmed": {
    "description": "Billing plan review or workspace selection text."
  },
  "billing.review.capacity": {
    "description": "Billing plan review or workspace selection text.",
    "placeholders": {
      "capacity": "Server-confirmed relative AI capacity."
    }
  },
  "billing.review.annual": {
    "description": "Billing plan review or workspace selection text.",
    "placeholders": {
      "amount": "Localized amount and currency from the server-reviewed Stripe price."
    }
  },
  "billing.review.monthly": {
    "description": "Billing plan review or workspace selection text.",
    "placeholders": {
      "amount": "Localized amount and currency from the server-reviewed Stripe price."
    }
  },
  "billing.review.equivalent": {
    "description": "Billing plan review or workspace selection text.",
    "placeholders": {
      "amount": "Localized amount and currency from the server-reviewed Stripe price."
    }
  },
  "billing.review.period": {
    "description": "Billing plan review or workspace selection text."
  },
  "billing.review.payHelp": {
    "description": "Billing plan review or workspace selection text."
  },
  "billing.review.comingSoonHelp": {
    "description": "Billing plan review or workspace selection text."
  },
  "billing.review.opening": {
    "description": "Billing plan review or workspace selection text."
  },
  "billing.review.continue": {
    "description": "Billing plan review or workspace selection text."
  },
  "billing.review.comingSoon": {
    "description": "Billing plan review or workspace selection text."
  },
  "billing.review.close": {
    "description": "Billing plan review or workspace selection text."
  },
  "billing.review.checkoutUnavailable": {
    "description": "Billing plan review or workspace selection text."
  },
  "billing.review.wrong_scope": {
    "description": "Billing plan review or workspace selection text."
  },
  "billing.review.scope_unconfirmed": {
    "description": "Billing plan review or workspace selection text."
  },
  "billing.review.existing_billing": {
    "description": "Billing plan review or workspace selection text."
  },
  "billing.review.covered_access": {
    "description": "Billing plan review or workspace selection text."
  },
  "billing.review.already_subscribed": {
    "description": "Billing plan review or workspace selection text."
  },
  "billing.review.personal_collaboration_review": {
    "description": "Billing plan review or workspace selection text."
  },
  "billing.selection.unavailable": {
    "description": "Billing plan review or workspace selection text."
  },
  "billing.selection.invalid": {
    "description": "Billing plan review or workspace selection text."
  },
  "billing.selection.compare": {
    "description": "Billing plan review or workspace selection text."
  },
  "billing.selection.loading": {
    "description": "Billing plan review or workspace selection text."
  },
  "billing.selection.title": {
    "description": "Billing plan review or workspace selection text."
  },
  "billing.selection.description": {
    "description": "Billing plan review or workspace selection text."
  },
  "billing.selection.signInHelp": {
    "description": "Billing plan review or workspace selection text."
  },
  "billing.selection.signIn": {
    "description": "Billing plan review or workspace selection text."
  },
  "billing.selection.create": {
    "description": "Billing plan review or workspace selection text."
  },
  "billing.selection.continue": {
    "description": "Billing plan review or workspace selection text."
  },
  "billing.selection.workspacesLoading": {
    "description": "Billing plan review or workspace selection text."
  },
  "billing.selection.workspacesUnavailable": {
    "description": "Billing plan review or workspace selection text."
  },
  "billing.selection.retry": {
    "description": "Billing plan review or workspace selection text."
  },
  "billing.selection.noWorkspace": {
    "description": "Billing plan review or workspace selection text."
  },
  "billing.selection.reviewFor": {
    "description": "Billing plan review or workspace selection text.",
    "placeholders": {
      "workspace": "Name of the workspace that will own this subscription."
    }
  },
  "billing.selection.workspaceFallback": {
    "description": "Billing plan review or workspace selection text.",
    "placeholders": {
      "id": "Workspace numeric identifier when its name is unavailable."
    }
  }
},
    _context: {
      description: "Organization billing, agent-credit usage, plan controls, and the organization-settings navigation that exposes them.",
    },
  },
  surfaces: [],
})
