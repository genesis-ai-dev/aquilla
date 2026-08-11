import { defineNamespace } from "./types"

export const auth = defineNamespace({
  keys: {
    // --- Login (/login) ---------------------------------------------------
    "auth.login.title": "Sign in",
    "auth.login.usernameLabel": "Username or email",
    "auth.login.passwordLabel": "Password",
    "auth.login.forgotPasswordLink": "Forgot password?",
    "auth.login.submitDefault": "Sign in",
    "auth.login.submitSigningIn": "Signing in…",
    "auth.login.submitMigrating": "Setting up your account and permissions…",
    "auth.login.migratingNote":
      "First-time sign-in may take a moment while we securely migrate your account.",
    "auth.login.newHerePrefix": "New here?",
    "auth.login.createAccountLink": "Create an account",

    // --- Reset password (/reset-password) ----------------------------------
    "auth.resetPassword.title": "Reset your password",
    "auth.resetPassword.accountPrefix": "Account:",
    "auth.resetPassword.verifyingLink": "Verifying link…",
    "auth.resetPassword.newPasswordLabel": "New password",
    "auth.resetPassword.checklistMinLength": "At least 8 characters",
    "auth.resetPassword.checklistStrengthPrefix": "Strength: {strength}",
    "auth.resetPassword.submitSetting": "Setting password…",
    "auth.resetPassword.submitDefault": "Set new password",
    "auth.resetPassword.emailRequired": "Email is required",
    "auth.resetPassword.emailInvalid": "Enter a valid email address",
    "auth.resetPassword.passwordTooShort": "Password must be at least 8 characters",
    "auth.resetPassword.failedToReset": "Failed to reset password",
    "auth.resetPassword.failedToSend": "Failed to send reset email",
    "auth.resetPassword.expiredBody":
      "This reset link has expired or is invalid. Enter your email address to request a new one",
    "auth.resetPassword.expiredForAccount": "for account",
    "auth.resetPassword.sentPrefix": "A new reset link has been sent to",
    "auth.resetPassword.sentSuffix":
      "Check your inbox and follow the link to choose a new password.",
    "auth.resetPassword.backToApp": "Back to app",
    "auth.resetPassword.requestNewLink": "Request a new link",
    "auth.resetPassword.sending": "Sending…",

    // --- Access link (/link/:token) ----------------------------------------
    "auth.accessLink.title": "Enter your PIN",
    "auth.accessLink.ariaLabel": "Enter your access PIN",
    "auth.accessLink.instructions": "Enter the PIN you were given to open your project.",
    "auth.accessLink.pinLabel": "PIN",
    "auth.accessLink.submitOpening": "Opening…",
    "auth.accessLink.submitDefault": "Open project",
    "auth.accessLink.genericError": "This link is invalid or has expired.",

    // --- Join / invite (/join/:token) ---------------------------------------
    "auth.join.invitedTitle": "You're invited",
    "auth.join.joiningTitle": "Joining Project",
    "auth.join.couldntLoad": "Couldn't load invitation",
    "auth.join.checkConnection": "Check your connection and try again.",
    "auth.join.alreadyUsedTitle": "This link has already been used",
    "auth.join.alreadyUsedBody":
      "This invite link is single-use and has already been redeemed. Ask the project " +
      "owner to send you a new invite link.",
    "auth.join.expiredTitle": "This link has expired",
    "auth.join.expiredBody":
      "This invite link is no longer valid because it has passed its expiry date. Ask " +
      "the project owner for a new invite link.",
    "auth.join.invalidTitle": "This invite link is no longer valid",
    "auth.join.invalidBody": "Ask the project owner for a new invite link.",
    "auth.join.tryAgain": "Try again",
    "auth.join.backToProjects": "Back to projects",
    "auth.join.acceptInvitation": "Accept invitation",
    "auth.join.notNow": "Not now",
    "auth.join.sessionExpiredNotice":
      "Your session expired — sign in again to join. Your invitation is still valid.",
    "auth.join.alreadyHaveAccount": "Already have an account?",
    "auth.join.logInLink": "Log in",
    "auth.join.emailPrefilledNote":
      "We've pre-filled the email from your invitation — you can use a different one if " +
      "you prefer.",
    "auth.join.emailUnboundNote":
      "This invite isn't bound to an email — sign up with any email you'd like.",
    "auth.join.postAuthNote": "After you sign in, you'll confirm and join — no need to come back.",
    "auth.join.joiningInProgress": "Joining project…",
    "auth.join.invalidInviteLink": "Invalid invite link",
    "auth.join.networkError": "Couldn't reach the server. Check your connection and try again.",
    "auth.join.wrongEmail": "This invite was sent to a different email address.",
    "auth.join.noLongerValidFresh":
      "This invite link is no longer valid. Ask the project owner for a fresh link.",
    "auth.join.loadingDetails": "Loading invitation details…",
    "auth.join.initializing": "Initializing…",
    "auth.join.projectLabel": "Project:",
    "auth.join.invitedByPrefix": "Invited by",
    "auth.join.youllJoinAs": "You'll join as",
    "auth.join.youllJoinEachAs": "You'll join each as",
    "auth.join.invitationSentTo": "invitation sent to",
    "auth.join.invitedToProjects": "You're invited to",
    "auth.join.projectCount": "{count} projects",
    "auth.join.archived": "archived",

    // --- Verify email (/verify-email) ---------------------------------------
    "auth.verifyEmail.missingToken": "This verification link is missing its token.",
    "auth.verifyEmail.verificationFailed": "Verification failed.",
    "auth.verifyEmail.verifying": "Verifying your email…",
    "auth.verifyEmail.verified": "Email verified",
    "auth.verifyEmail.confirmedBody": "Thanks — your email address is confirmed.",
    "auth.verifyEmail.goToApp": "Go to Aquilla",
    "auth.verifyEmail.couldntVerify": "Couldn't verify",
    "auth.verifyEmail.stillUsable":
      "You can still use Aquilla — verification isn't required to sign in.",

    // --- Marketing demo auto-login (/__marketing/login) ---------------------
    "auth.marketingLogin.unavailable": "Demo is unavailable in this environment.",
    "auth.marketingLogin.loading": "Loading the Aquilla demo…",
    "auth.marketingLogin.settingUp": "Setting up a curated project for you.",

    // --- Session-expired banner (global) ------------------------------------
    "auth.sessionExpired.message": "Your session expired.",
    "auth.sessionExpired.signInAgain": "Sign in again",
    "auth.sessionExpired.continueSuffix": "to continue.",
  },
  context: {
    _context: {
      description:
        "Pre-authentication and account-access screens: sign-in, password reset, " +
        "email verification, invite/join links, and the deep-link PIN flow used in " +
        "surveillance-sensitive contexts. For most translators this is the very first " +
        "screen Aquilla ever shows them, so wording should be plain and welcoming — " +
        "avoid jargon and assume the reader has never used the product before.",
      screenshot: "auth",
    },
    keys: {
      "auth.login.title": {
        description:
          "Heading of the sign-in form. Short imperative/label phrase naming the " +
          "action of the whole page, not a greeting.",
      },
      "auth.login.usernameLabel": {
        description:
          "Form label above the username/email field on the sign-in form. The field " +
          "accepts either identifier, so avoid a translation that implies only one is " +
          "valid.",
      },
      "auth.login.passwordLabel": {
        description:
          "Form label above the password field on the sign-in form. Must read as " +
          "exactly 'Password', not a variant like 'Your password' — a show/hide toggle " +
          "sits beside the field and has its own separate label.",
      },
      "auth.login.forgotPasswordLink": {
        description:
          "Small text-button beside the password label that switches the form to the " +
          "password-recovery flow. Phrased as a question in English; keep it short " +
          "enough to sit inline with the label.",
        maxLength: 30,
      },
      "auth.login.submitDefault": {
        description:
          "Primary submit button on the sign-in form in its resting state. Imperative, " +
          "matches the page heading.",
      },
      "auth.login.submitSigningIn": {
        description:
          "Submit button label while the sign-in request is in flight (normal, fast " +
          "path). Present continuous, ends with an ellipsis glyph (…).",
      },
      "auth.login.submitMigrating": {
        description:
          "Submit button label shown instead of 'Signing in…' the first time a " +
          "legacy account signs in and the server is migrating it in the background — " +
          "this path is slower than a normal sign-in. Present continuous, ends with an " +
          "ellipsis glyph (…).",
      },
      "auth.login.migratingNote": {
        description:
          "Small status paragraph shown under the submit button only during the " +
          "first-time account migration described above, so the user understands why " +
          "sign-in is taking longer than usual. Announced to screen readers via " +
          "aria-live.",
      },
      "auth.login.newHerePrefix": {
        description:
          "Short question introducing the 'Create an account' link/button to a " +
          "signed-out user who doesn't have an Aquilla account yet. Appears on both " +
          "the sign-in page and the invite-landing page's inline sign-up prompt.",
      },
      "auth.login.createAccountLink": {
        description:
          "Link or button that switches from signing in to creating a new account. " +
          "Reused on the sign-in page (as a link to onboarding) and on the invite " +
          "landing page (as a mode toggle) — same intent both places: start the " +
          "sign-up flow.",
      },
      "auth.resetPassword.title": {
        description:
          "Heading shared by the /reset-password page and the sign-in page's " +
          "'forgot password' mode. Names the action the whole form performs.",
      },
      "auth.resetPassword.accountPrefix": {
        description:
          "Label word before the username on the reset-password page, e.g. " +
          "'Account: alice'. Keep it short — the username follows immediately after.",
      },
      "auth.resetPassword.verifyingLink": {
        description:
          "Momentary status text shown while the app checks whether the password-" +
          "reset link in the URL is still valid, before either the new-password form " +
          "or the expired-link recovery view appears.",
      },
      "auth.resetPassword.newPasswordLabel": {
        description: "Form label above the new-password field on a valid reset link.",
      },
      "auth.resetPassword.checklistMinLength": {
        description:
          "One line of a live password-requirements checklist, shown with a check or " +
          "cross icon beside it as the user types. States the minimum length rule.",
      },
      "auth.resetPassword.checklistStrengthPrefix": {
        description:
          "Label before the live password-strength word, e.g. 'Strength: strong'. The " +
          "{strength} value itself is produced by shared password-scoring code as an " +
          "English word (weak/medium/strong) and is not translated by this key — only " +
          "translate the 'Strength:' label text.",
        placeholders: {
          strength: "English strength word from shared scoring code — do not translate.",
        },
      },
      "auth.resetPassword.submitSetting": {
        description:
          "Submit button label on the new-password form while the request is in " +
          "flight. Present continuous, ends with an ellipsis glyph (…).",
      },
      "auth.resetPassword.submitDefault": {
        description: "Submit button on the new-password form in its resting state.",
      },
      "auth.resetPassword.emailRequired": {
        description:
          "Inline validation error on the recovery form's email field when it is " +
          "submitted empty.",
      },
      "auth.resetPassword.emailInvalid": {
        description:
          "Inline validation error on the recovery form's email field when the value " +
          "isn't a well-formed email address.",
      },
      "auth.resetPassword.passwordTooShort": {
        description:
          "Inline validation error on the new-password field when the password is " +
          "shorter than the minimum length.",
      },
      "auth.resetPassword.failedToReset": {
        description:
          "Fallback form-level error shown when setting the new password fails for a " +
          "reason the server didn't describe in a friendlier message.",
      },
      "auth.resetPassword.failedToSend": {
        description:
          "Fallback form-level error shown when requesting a fresh reset-link email " +
          "fails for a reason the server didn't describe in a friendlier message.",
      },
      "auth.resetPassword.expiredBody": {
        description:
          "Opening sentence of the notice shown when a reset link is expired or " +
          "invalid, explaining what to do next. Continues inline with either a period " +
          "or, when the username is known, ' for account <name>.' — keep this " +
          "fragment able to lead into that continuation.",
      },
      "auth.resetPassword.expiredForAccount": {
        description:
          "Mid-sentence connector inserted only when the expired link's username is " +
          "known, forming '…request a new one for account <name>.' Lowercase, no " +
          "surrounding punctuation.",
      },
      "auth.resetPassword.sentPrefix": {
        description:
          "Opening fragment of the confirmation shown after a new reset-link email is " +
          "requested; the recipient's email address (bolded) is inserted right after " +
          "this text, e.g. '<this text> alice@example.com. <suffix>'.",
      },
      "auth.resetPassword.sentSuffix": {
        description:
          "Closing sentence of the reset-link-sent confirmation, following the email " +
          "address inserted after auth.resetPassword.sentPrefix.",
      },
      "auth.resetPassword.backToApp": {
        description:
          "Link back to the main app, shown on the expired-link recovery view before " +
          "and after requesting a new link.",
      },
      "auth.resetPassword.requestNewLink": {
        description:
          "Submit button on the expired-link recovery form that requests a fresh " +
          "reset-password email.",
      },
      "auth.resetPassword.sending": {
        description:
          "Submit button label on the recovery form while the new reset-link email is " +
          "being requested. Present continuous, ends with an ellipsis glyph (…).",
      },
      "auth.accessLink.title": {
        description:
          "Heading of the PIN-entry landing page reached via a per-user access link " +
          "(/link/:token) — a link-plus-PIN flow used for translators working in " +
          "surveillance-sensitive contexts on a browser that keeps no session.",
      },
      "auth.accessLink.ariaLabel": {
        description:
          "Accessible name of the PIN-entry form for screen-reader users; not " +
          "visibly rendered.",
      },
      "auth.accessLink.instructions": {
        description:
          "One-line instruction under the heading, telling the user what the PIN is " +
          "for and where they got it.",
      },
      "auth.accessLink.pinLabel": {
        description: "Form label for the PIN input field. Very short — a numeric code.",
        maxLength: 12,
      },
      "auth.accessLink.submitOpening": {
        description:
          "Submit button label while the PIN is being redeemed. Present continuous, " +
          "ends with an ellipsis glyph (…).",
      },
      "auth.accessLink.submitDefault": {
        description: "Submit button in its resting state, before the PIN is submitted.",
      },
      "auth.accessLink.genericError": {
        description:
          "The ONLY error message this page ever shows, deliberately identical " +
          "whether the link is unknown, expired, revoked, or the PIN was simply wrong " +
          "— by design, so an attacker guessing PINs against a valid link learns " +
          "nothing from the response. Do not translate this in a way that implies a " +
          "more specific cause.",
      },
      "auth.join.invitedTitle": {
        description:
          "Card heading on the invite-landing page while the invite is still being " +
          "previewed or confirmed, for a not-yet-a-member visitor.",
      },
      "auth.join.joiningTitle": {
        description:
          "Card heading on the invite-landing page once the visitor has clicked " +
          "Accept and the membership is being created.",
      },
      "auth.join.couldntLoad": {
        description:
          "Error heading shown when the invite preview couldn't be fetched due to a " +
          "network problem (as opposed to the invite itself being invalid).",
      },
      "auth.join.checkConnection": {
        description: "One-line detail under auth.join.couldntLoad suggesting what to do.",
      },
      "auth.join.alreadyUsedTitle": {
        description:
          "Error heading shown when the invite link has already been redeemed by " +
          "someone (it is single-use).",
      },
      "auth.join.alreadyUsedBody": {
        description: "Explanatory detail under auth.join.alreadyUsedTitle.",
      },
      "auth.join.expiredTitle": {
        description: "Error heading shown when the invite link has passed its expiry date.",
      },
      "auth.join.expiredBody": {
        description: "Explanatory detail under auth.join.expiredTitle.",
      },
      "auth.join.invalidTitle": {
        description:
          "Generic error heading for an invite link that isn't valid for any other " +
          "specific, distinguishable reason.",
      },
      "auth.join.invalidBody": {
        description: "Explanatory detail under auth.join.invalidTitle.",
      },
      "auth.join.tryAgain": {
        description:
          "Retry button shown only after a network failure loading the invite " +
          "preview; reloads the page.",
      },
      "auth.join.backToProjects": {
        description:
          "Button that navigates away from a failed or declined invite flow back to " +
          "the user's project list.",
      },
      "auth.join.acceptInvitation": {
        description:
          "Primary button a signed-in user clicks to actually join the project(s) an " +
          "invite grants access to. Membership changes only on this explicit click.",
      },
      "auth.join.notNow": {
        description:
          "Secondary button beside auth.join.acceptInvitation that declines to accept " +
          "right now and returns to the user's projects, without invalidating the " +
          "invite.",
      },
      "auth.join.sessionExpiredNotice": {
        description:
          "Reassuring note shown when a signed-in user's stored session has expired " +
          "on the invite-landing page, so they understand they're being asked to sign " +
          "in again — not that the invite failed.",
      },
      "auth.join.alreadyHaveAccount": {
        description:
          "Short question introducing the 'Log in' link/button in the inline sign-up " +
          "form on the invite-landing page, for a visitor who already has an account.",
      },
      "auth.join.logInLink": {
        description:
          "Link/button beside auth.join.alreadyHaveAccount that switches the inline " +
          "auth form from sign-up to sign-in.",
      },
      "auth.join.emailPrefilledNote": {
        description:
          "Helper text shown above the inline sign-up form when the invite is bound " +
          "to a specific email address, which the form pre-fills. Reassures the user " +
          "the field is still editable.",
      },
      "auth.join.emailUnboundNote": {
        description:
          "Helper text shown above the inline sign-up form when the invite link is " +
          "an anyone-with-the-link invite with no bound email, so the empty email " +
          "field doesn't look like a bug.",
      },
      "auth.join.postAuthNote": {
        description:
          "Small reassurance under the inline auth form explaining that after " +
          "signing in the user returns straight to this page to confirm joining — " +
          "they don't need to re-open the invite link.",
      },
      "auth.join.joiningInProgress": {
        description:
          "Status text shown briefly while the accept-invite request is in flight, " +
          "beside a spinner.",
      },
      "auth.join.invalidInviteLink": {
        description:
          "Error message shown when the invite URL itself is malformed and carries no " +
          "token at all (distinct from a token that resolves but is expired/used).",
      },
      "auth.join.networkError": {
        description:
          "Error shown when accepting the invite (after clicking " +
          "auth.join.acceptInvitation) fails due to a network problem, as opposed to " +
          "the invite being rejected by the server.",
      },
      "auth.join.wrongEmail": {
        description:
          "Error shown when accepting fails because the invite is bound to a " +
          "different email address than the signed-in account's.",
      },
      "auth.join.noLongerValidFresh": {
        description:
          "Error shown when accepting an invite fails for a definitive server reason " +
          "(used/expired/unknown token) discovered at accept time, distinct from the " +
          "similar-sounding preview-time errors above — tells the user to ask for a " +
          "brand-new link.",
      },
      "auth.join.loadingDetails": {
        description:
          "Placeholder text shown in place of the invite summary while it is still " +
          "loading.",
      },
      "auth.join.initializing": {
        description: "Placeholder text for the brief instant before any other state applies.",
      },
      "auth.join.projectLabel": {
        description:
          "Label word before the project name in the single-project invite summary " +
          "card, e.g. 'Project: Genesis Pilot'.",
      },
      "auth.join.invitedByPrefix": {
        description:
          "Label word before the inviter's name in the invite summary, e.g. " +
          "'Invited by Prabhu — you'll join as Contributor.' Omitted entirely when " +
          "the inviter is unknown.",
      },
      "auth.join.youllJoinAs": {
        description:
          "Fragment of the invite-summary sentence for a SINGLE project, immediately " +
          "followed by the role name, e.g. '<this text> Contributor.' Must not contain " +
          "the word 'each' — that variant is auth.join.youllJoinEachAs.",
      },
      "auth.join.youllJoinEachAs": {
        description:
          "Fragment of the invite-summary sentence for MULTIPLE projects, immediately " +
          "followed by the role name, e.g. '<this text> Contributor.' The role applies " +
          "to every listed project, hence 'each'.",
      },
      "auth.join.invitationSentTo": {
        description:
          "Mid-sentence fragment naming who an email-bound invite was sent to, e.g. " +
          "'— invitation sent to alice@example.com.' Lowercase, no surrounding " +
          "punctuation.",
      },
      "auth.join.invitedToProjects": {
        description:
          "Opening fragment of the multi-project invite summary, immediately followed " +
          "by the bolded project count, e.g. '<this text> 3 projects:'.",
      },
      "auth.join.projectCount": {
        description:
          "Bolded project-count fragment following auth.join.invitedToProjects. Only " +
          "used for 2+ projects (the 1-project case uses auth.join.projectLabel " +
          "instead), so no singular form is needed.",
        placeholders: {
          count: "Number of projects the invite grants access to (always 2 or more here).",
        },
      },
      "auth.join.archived": {
        description:
          "Single word appended in parentheses after a project's name in the invite " +
          "list when that project has since been archived, e.g. 'Genesis (archived)'.",
      },
      "auth.verifyEmail.missingToken": {
        description:
          "Error shown when the email-verification link was opened without its " +
          "required token query parameter.",
      },
      "auth.verifyEmail.verificationFailed": {
        description:
          "Fallback error shown when verifying the email-confirmation token fails for " +
          "a reason the server didn't describe in a friendlier message.",
      },
      "auth.verifyEmail.verifying": {
        description: "Momentary status text shown while the verification request is in flight.",
      },
      "auth.verifyEmail.verified": {
        description:
          "Success heading shown once the email address has been confirmed. This page " +
          "is purely confirmatory — the user is never blocked from using Aquilla " +
          "regardless of verification status.",
      },
      "auth.verifyEmail.confirmedBody": {
        description: "One-line reassurance under auth.verifyEmail.verified.",
      },
      "auth.verifyEmail.goToApp": {
        description:
          "Button that returns to the main app, shown on both the success and error " +
          "outcomes of this page.",
      },
      "auth.verifyEmail.couldntVerify": {
        description: "Error heading shown when the verification link could not be processed.",
      },
      "auth.verifyEmail.stillUsable": {
        description:
          "Reassurance shown under a verification failure, making clear the user can " +
          "keep using Aquilla — verification is optional, not a gate.",
      },
      "auth.marketingLogin.unavailable": {
        description:
          "Error shown on the curated public-demo auto-login page when the demo " +
          "backend isn't enabled in the current environment.",
      },
      "auth.marketingLogin.loading": {
        description:
          "Heading shown while the demo auto-login page is signing the visitor into " +
          "the curated demo project.",
      },
      "auth.marketingLogin.settingUp": {
        description:
          "Status line under auth.marketingLogin.loading while the demo session is " +
          "being prepared.",
      },
      "auth.sessionExpired.message": {
        description:
          "First sentence of the dismissible top banner shown anywhere in the app " +
          "when the user's session has expired mid-use. Followed immediately by the " +
          "auth.sessionExpired.signInAgain link and then " +
          "auth.sessionExpired.continueSuffix.",
      },
      "auth.sessionExpired.signInAgain": {
        description:
          "Inline link inside the session-expired banner that goes to /login, " +
          "preserving the current page so the user returns to it after signing back " +
          "in.",
      },
      "auth.sessionExpired.continueSuffix": {
        description:
          "Final fragment of the session-expired banner sentence, immediately after " +
          "the auth.sessionExpired.signInAgain link, e.g. '…Sign in again <this text>'",
      },
    },
  },
  surfaces: [
    {
      id: "auth",
      title: "Sign in",
      route: "/login",
      notes:
        "Pre-authentication sign-in screen — the first screen a new translator sees, " +
        "reached signed out with no dev-login bypass. Centered narrow-column form: " +
        "heading, username/email field, password field with a forgot-password link, " +
        "and a full-width submit button.",
    },
  ],
})
