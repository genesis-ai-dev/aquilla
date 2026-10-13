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

    "billing.change.title": "Review plan change",
    "billing.change.loading": "Checking the subscription and change amount…",
    "billing.change.unavailable": "Plan change review is unavailable. Your current plan stays unchanged.",
    "billing.change.retry": "Try change review again",
    "billing.change.dueNow": "Prorated charge due now: {amount}.",
    "billing.change.upgradeHelp": "The higher cap starts after successful payment. Your usage this week stays counted.",
    "billing.change.downgradeStarts": "No charge now. The lower plan starts at the next billing cycle, {date}.",
    "billing.change.downgradeHelp": "Your current plan and cap continue until then. Your usage week does not restart when the lower cap takes effect.",
    "billing.change.usageResets": "Weekly usage resets {date}.",
    "billing.change.expires": "This review expires {date}. Reviewing does not change your plan.",
    "billing.change.comingSoon": "Plan changes coming soon",
    "billing.change.close": "Close change review",

    "billing.offers.title": "Compare new plans",
    "billing.offers.intro": "Compare personal and shared team capacity. Paid checkout is coming soon. Your current workspace plan stays unchanged.",
    "billing.offers.audienceAria": "Plan audience",
    "billing.offers.individual": "Individual",
    "billing.offers.team": "Team & Enterprise",
    "billing.offers.intervalAria": "Plan billing period",
    "billing.offers.annual": "Annual",
    "billing.offers.monthly": "Monthly",
    "billing.offers.freeDescription": "Explore Aquilla with basic AI assistance. No card required.",
    "billing.offers.loading": "Loading plan prices…",
    "billing.offers.unavailable": "Plan prices are temporarily unavailable. Your current plan and access are unchanged.",
    "billing.offers.teamCapacity": "{capacity} capacity, shared across your team.",
    "billing.offers.personalCapacity": "{capacity} capacity for your personal workspace.",
    "billing.offers.perMonth": "{amount}/month",
    "billing.offers.billedAnnually": "{amount} billed annually",
    "billing.offers.billedMonthly": "Billed monthly",
    "billing.offers.review": "Review {plan}",
    "billing.offers.enterpriseDescription": "An agreed plan for organization-wide rollout and support.",
    "billing.offers.discussRollout": "Discuss your rollout",
    "billing.offers.resetNote": "New plans reset AI capacity every seven days, with no rollover. Monthly or annual billing does not change usage resets. Usage varies with the work performed.",

    "billing.workspace.title": "Workspace billing",
    "billing.workspace.unavailable": "Workspace billing details are unavailable. Your current access stays unchanged.",
    "billing.workspace.loading": "Loading workspace billing…",
    "billing.workspace.eligibility.ready": "Plan options match this workspace. Paid checkout is not open yet.",
    "billing.workspace.eligibility.scope_unconfirmed": "Confirm this workspace’s type with support before choosing a paid plan. Your existing access stays unchanged.",
    "billing.workspace.eligibility.already_subscribed": "This workspace already has a paid plan. Changes will be available when billing management is ready.",
    "billing.workspace.eligibility.personal_collaboration_review": "This personal workspace has collaborators. Contact us to confirm the right plan before purchasing.",
    "billing.workspace.manageInStripe": "Use Manage billing to update this workspace’s subscription in Stripe.",
    "billing.workspace.paymentFailed": "Payment failed. Your AI allowance falls back to Free. This week’s usage still counts; if it exceeds Free’s allowance, AI pauses until the weekly reset or payment recovery.",
    "billing.workspace.paidPeriodEnded": "Your paid period has ended. Your AI allowance follows Free, with this week’s usage still counted.",
    "billing.workspace.canceled": "Your subscription is canceled. Paid access continues through {date}.",
    "billing.workspace.paidThrough": "Paid access is confirmed through {date}.",
    "billing.workspace.allowanceScope": "Work on this workspace’s projects uses this workspace’s allowance. A collaborator’s personal subscription does not add capacity here.",
    "billing.workspace.usagePercent": "{percent}% of this week’s AI allowance used. Resets {date}.",
    "billing.workspace.usagePeriodEnds": "Usage period ends {date}. Usage measurement is not available yet.",

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
    "billing.plan.free": "Free",
    "billing.plan.enterprise": "Enterprise",
    "billing.plan.billedAnnually": "Billed annually.",
    "billing.plan.billedMonthly": "Billed monthly.",
    "billing.plan.enterpriseHelp": "Custom annual quote for support and platform usage.",
    "billing.plan.coverageHelp": "Your organization’s plan covers its projects and collaborators.",
    "billing.plan.manageStripeHelp": "Manage your plan, invoices, and payment methods securely with Stripe.",
    "billing.portal.redirecting": "Redirecting…",
    "billing.portal.manage": "Manage billing",
    "billing.portal.open": "Open customer portal",
    "billing.portal.startFailed": "Couldn't start Stripe.",
    "billing.loadFailed": "Billing details are unavailable. Try again; your access stays unchanged.",
    "billing.retry": "Retry billing",
    "billing.refresh": "Refresh billing",
    "billing.checkout.rehearsal": "Test checkout returned. Refresh billing to check payment confirmation.",
    "billing.checkout.success": "Checkout completed. Your plan updates after payment is confirmed.",
    "billing.checkout.canceled": "Checkout canceled.",
    "billing.coverage.title": "Plans and covered access",
    "billing.coverage.etenQuestion": "ETEN affiliate or Bible-translation team?",
    "billing.coverage.etenHelp": "Your organization’s access may already be covered. Contact us to confirm coverage and arrange access without paying for a subscription.",
    "billing.coverage.check": "Check covered access",
    "billing.plans.compareHelp": "See Individual and Team pricing or discuss a custom annual Enterprise quote.",
    "billing.plans.view": "View plans",
    "billing.aiUsage.title": "AI usage",
    "billing.aiUsage.shared": "Collaborators share your organization’s AI allowance across its projects.",
    "billing.aiUsage.paidReset": "AI capacity resets every seven days from your plan’s activation, with no rollover. Monthly or annual billing does not change this schedule.",
    "billing.aiUsage.notMeasured": "Usage measurement is not available yet.",
    "billing.aiUsage.rollingWindow": "Weekly limits use a rolling seven-day window. Capacity returns as older usage leaves the window. Daily limits may also apply.",
    "billing.aiUsage.pauseNote": "Usage limits may pause affected AI requests until capacity is available again. Your projects remain available for manual editing and review.",
    "billing.aiUsage.noSelfService": "Self-service allowance purchases are not available. Contact us if your organization needs more capacity.",
    "billing.aiUsage.contact": "Discuss AI capacity",
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
  },
  "billing.change.title": {
    "description": "Heading of the panel that previews switching this workspace from its current paid plan to another plan. Screen readers also read it as the panel's name."
  },
  "billing.change.loading": {
    "description": "Status line shown while the plan-change panel loads the subscription and the amount the change would cost."
  },
  "billing.change.unavailable": {
    "description": "Alert shown when the plan-change review cannot load. Says that the current plan did not change."
  },
  "billing.change.retry": {
    "description": "Button that loads the plan-change review again after it failed."
  },
  "billing.change.dueNow": {
    "description": "Line in the plan-change review for an upgrade: the prorated amount charged immediately for the move to a higher plan.",
    "placeholders": {
      "amount": "Currency amount charged now, already formatted (for example \"$12.50\"). Shown in bold."
    }
  },
  "billing.change.upgradeHelp": {
    "description": "Explains an upgrade: the higher AI usage cap applies only after payment succeeds, and usage already recorded this week still counts."
  },
  "billing.change.downgradeStarts": {
    "description": "Line in the plan-change review for a downgrade: nothing is charged now, and the lower plan starts at the next billing cycle.",
    "placeholders": {
      "date": "Date and time the next billing cycle starts, already formatted for the user's locale."
    }
  },
  "billing.change.downgradeHelp": {
    "description": "Explains a downgrade: the current plan and its usage cap stay in force until the next billing cycle, and the switch does not restart the weekly usage window."
  },
  "billing.change.usageResets": {
    "description": "Line in the plan-change review that states when the weekly AI usage count resets.",
    "placeholders": {
      "date": "Date and time of the next weekly usage reset, already formatted for the user's locale."
    }
  },
  "billing.change.expires": {
    "description": "Line in the plan-change review that states when this price preview stops being valid. Reviewing alone does not switch plans.",
    "placeholders": {
      "date": "Date and time this review expires, already formatted for the user's locale."
    }
  },
  "billing.change.comingSoon": {
    "description": "Disabled button at the end of the plan-change review. Switching plans is not available yet, so the label says it is coming soon."
  },
  "billing.change.close": {
    "description": "Button that closes the plan-change review without changing anything."
  },
  "billing.offers.title": {
    "description": "Heading of the billing-page section that lists the new paid plans and their prices."
  },
  "billing.offers.intro": {
    "description": "Text under the Compare new plans heading: plans differ by personal or shared team capacity, paid checkout is not open yet, and the current plan is not affected."
  },
  "billing.offers.audienceAria": {
    "description": "Accessible name for the tab list that switches the plan list between plans for one person and plans for a team. Read only by screen readers."
  },
  "billing.offers.individual": {
    "description": "Tab label: shows the plans for one person's personal workspace. Keep it short."
  },
  "billing.offers.team": {
    "description": "Tab label: shows the plans that a team shares, and the custom Enterprise option. Keep it short. Enterprise is a plan name."
  },
  "billing.offers.intervalAria": {
    "description": "Accessible name for the drop-down that selects how often a plan is billed (every year or every month). Read only by screen readers."
  },
  "billing.offers.annual": {
    "description": "Option in the billing-period drop-down: the plan is billed once a year. Adjective that describes the billing period."
  },
  "billing.offers.monthly": {
    "description": "Option in the billing-period drop-down: the plan is billed every month. Adjective that describes the billing period."
  },
  "billing.offers.freeDescription": {
    "description": "Description of the Free plan in the plan list: basic AI help, and no payment card is necessary."
  },
  "billing.offers.loading": {
    "description": "Status line shown while plan prices load."
  },
  "billing.offers.unavailable": {
    "description": "Status line shown when plan prices cannot load. Says that the current plan and access did not change."
  },
  "billing.offers.teamCapacity": {
    "description": "Description of a team plan in the plan list: everyone on the team shares its AI capacity.",
    "placeholders": {
      "capacity": "Plan capacity label from the server, relative to the Pro plan (for example \"20× Pro\"). Not translated."
    }
  },
  "billing.offers.personalCapacity": {
    "description": "Description of an individual plan in the plan list: its AI capacity applies to one personal workspace.",
    "placeholders": {
      "capacity": "Plan capacity label from the server, relative to the Pro plan (for example \"5× Pro\"). Not translated."
    }
  },
  "billing.offers.perMonth": {
    "description": "Price per month shown beside a plan. For a yearly plan, this is the yearly total divided by 12.",
    "placeholders": {
      "amount": "Currency amount per month, already formatted (for example \"$20\")."
    }
  },
  "billing.offers.billedAnnually": {
    "description": "Small text under the monthly price of a yearly plan: the total that is charged once a year.",
    "placeholders": {
      "amount": "Yearly total, already formatted as currency (for example \"$240\")."
    }
  },
  "billing.offers.billedMonthly": {
    "description": "Small text under the price of a monthly plan: the plan is charged every month."
  },
  "billing.offers.review": {
    "description": "Button on each plan row that opens a review of that plan before purchase.",
    "placeholders": {
      "plan": "Product name of the plan (for example \"Pro\" or \"Team 20×\"). Not translated."
    }
  },
  "billing.offers.enterpriseDescription": {
    "description": "Description of the Enterprise row in the team plan list: a negotiated plan that covers a rollout across the organization, with support."
  },
  "billing.offers.discussRollout": {
    "description": "Link that opens the Aquilla rollout page to start a conversation about an Enterprise plan."
  },
  "billing.offers.resetNote": {
    "description": "Note under the plan list: AI capacity resets every seven days and unused capacity does not carry over, the billing period does not change the reset schedule, and usage depends on the work done."
  },
  "billing.workspace.title": {
    "description": "Heading of the billing-page section that names the workspace this billing applies to and describes its current access."
  },
  "billing.workspace.unavailable": {
    "description": "Status line shown when workspace billing details cannot load. Says that current access did not change."
  },
  "billing.workspace.loading": {
    "description": "Status line shown while workspace billing details load."
  },
  "billing.workspace.eligibility.ready": {
    "description": "Workspace billing explanation: the listed plans fit this workspace, but paid checkout is not open yet."
  },
  "billing.workspace.eligibility.scope_unconfirmed": {
    "description": "Workspace billing explanation: support must confirm whether this workspace is personal or a team before a paid plan can be chosen."
  },
  "billing.workspace.eligibility.already_subscribed": {
    "description": "Workspace billing explanation: this workspace already has a paid plan, and plan changes will come later."
  },
  "billing.workspace.eligibility.personal_collaboration_review": {
    "description": "Workspace billing explanation: a personal workspace that has collaborators needs a conversation with us before a plan is purchased."
  },
  "billing.workspace.manageInStripe": {
    "description": "Help text for a workspace that already has a paid plan. \"Manage billing\" is the label of the button on this page (billing.portal.manage); use the same translation. Stripe is the payment provider's name; do not translate it."
  },
  "billing.workspace.paymentFailed": {
    "description": "Status after a payment failed: the workspace gets the AI allowance of the Free plan, and AI can pause if this week's usage is already over that allowance. \"Free\" is the plan name (billing.plan.free)."
  },
  "billing.workspace.paidPeriodEnded": {
    "description": "Status after the paid period ended: the workspace now gets the AI allowance of the Free plan. \"Free\" is the plan name (billing.plan.free)."
  },
  "billing.workspace.canceled": {
    "description": "Status after the subscription was canceled: paid access continues until the end of the period that was already paid for.",
    "placeholders": {
      "date": "Date and time paid access ends, already formatted for the user's locale."
    }
  },
  "billing.workspace.paidThrough": {
    "description": "Status for an active paid plan: the date until which paid access is confirmed.",
    "placeholders": {
      "date": "Date and time until which paid access is confirmed, already formatted for the user's locale."
    }
  },
  "billing.workspace.allowanceScope": {
    "description": "Explains that AI use in this workspace's projects draws on this workspace's own allowance, and that a collaborator's personal subscription does not add to it."
  },
  "billing.workspace.usagePercent": {
    "description": "Status line with this week's AI usage as a percentage of the allowance, and when the count resets.",
    "placeholders": {
      "percent": "Whole number from 0 to 100. The string puts the percent sign after it; move the sign if the target language writes it before the number.",
      "date": "Date and time of the next weekly reset, already formatted for the user's locale."
    }
  },
  "billing.workspace.usagePeriodEnds": {
    "description": "Shown when usage measurement is not available yet: states when the current usage period ends.",
    "placeholders": {
      "date": "Date and time the usage period ends, already formatted for the user's locale."
    }
  },
  "billing.plan.free": {
    "description": "Name of the free plan. Shown as the plan badge under Current plan and as a row in the plan list."
  },
  "billing.plan.enterprise": {
    "description": "Name of the Enterprise plan (custom pricing for organizations). Shown as the plan badge under Current plan and as a row in the plan list."
  },
  "billing.plan.billedAnnually": {
    "description": "Description under Current plan for a paid plan that is billed once a year."
  },
  "billing.plan.billedMonthly": {
    "description": "Description under Current plan for a paid plan that is billed every month."
  },
  "billing.plan.enterpriseHelp": {
    "description": "Description under Current plan for the Enterprise plan: its price is a custom yearly quote that covers support and platform use."
  },
  "billing.plan.coverageHelp": {
    "description": "Description under Current plan for other plans: the organization's plan applies to all of its projects and collaborators."
  },
  "billing.plan.manageStripeHelp": {
    "description": "Help text beside the Manage billing button for a paid workspace plan. Stripe is the payment provider's name; do not translate it."
  },
  "billing.portal.redirecting": {
    "description": "Button label shown while the app opens the Stripe billing portal."
  },
  "billing.portal.manage": {
    "description": "Button that opens the Stripe billing portal for a paid workspace plan."
  },
  "billing.portal.open": {
    "description": "Button that opens the Stripe customer portal for an older organization plan."
  },
  "billing.portal.startFailed": {
    "description": "Alert shown when the Stripe billing portal could not be opened and no specific reason is available. Stripe is the payment provider's name; do not translate it."
  },
  "billing.loadFailed": {
    "description": "Alert shown when the billing page cannot load the billing details. Says that the user can try again and that their access did not change. A Retry billing button appears with it."
  },
  "billing.retry": {
    "description": "Button shown when billing details failed to load. Loads them again."
  },
  "billing.refresh": {
    "description": "Button that loads the billing details again, for example after the user returns from payment."
  },
  "billing.checkout.rehearsal": {
    "description": "Notice shown when the user returns from a test checkout. Tells them to refresh billing to see whether the payment was confirmed."
  },
  "billing.checkout.success": {
    "description": "Notice shown when the user returns from a completed checkout. The plan changes only after the payment is confirmed."
  },
  "billing.checkout.canceled": {
    "description": "Notice shown when the user left checkout without paying."
  },
  "billing.coverage.title": {
    "description": "Heading of the billing-page section about plan options and about access that can already be covered for Bible-translation organizations."
  },
  "billing.coverage.etenQuestion": {
    "description": "Row label that asks whether the organization is an ETEN affiliate or a Bible-translation team. ETEN is the name of a Bible-translation alliance; do not translate it."
  },
  "billing.coverage.etenHelp": {
    "description": "Text under the ETEN question: such organizations can already have covered access, and should contact us instead of paying for a subscription."
  },
  "billing.coverage.check": {
    "description": "Button that starts an email to us to check whether the organization's access is covered."
  },
  "billing.plans.compareHelp": {
    "description": "Text under Compare plans: the pricing page shows Individual and Team prices, or the user can discuss a custom yearly Enterprise quote. Individual, Team, and Enterprise are plan names."
  },
  "billing.plans.view": {
    "description": "Link that opens the public pricing page."
  },
  "billing.aiUsage.title": {
    "description": "Heading of the billing-page section that explains how AI usage limits work."
  },
  "billing.aiUsage.shared": {
    "description": "Explains that everyone who works in the organization uses one shared AI allowance."
  },
  "billing.aiUsage.paidReset": {
    "description": "For paid plans: AI capacity resets every seven days from the date the plan started, unused capacity does not carry over, and the billing period does not change the reset schedule."
  },
  "billing.aiUsage.notMeasured": {
    "description": "Notice that usage numbers are not shown yet, because usage measurement is not available."
  },
  "billing.aiUsage.rollingWindow": {
    "description": "For plans without a paid subscription: weekly limits count the usage of the last seven days, so capacity comes back as older usage leaves that window. Daily limits can also apply."
  },
  "billing.aiUsage.pauseNote": {
    "description": "Explains that a usage limit can pause AI requests until capacity comes back, while manual editing and review continue to work."
  },
  "billing.aiUsage.noSelfService": {
    "description": "Explains that more AI allowance cannot be bought in the app; the user must contact us instead."
  },
  "billing.aiUsage.contact": {
    "description": "Link that starts an email to support about more AI capacity."
  }
},
    _context: {
      description: "Organization billing, agent-credit usage, plan controls, and the organization-settings navigation that exposes them.",
    },
  },
  surfaces: [],
})
