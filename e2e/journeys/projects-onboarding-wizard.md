# Sign up and walk the onboarding wizard end to end

Smoke twin: `e2e/specs/projects/onboarding.smoke.spec.ts`

## Preconditions

- No login needed. Open `/onboarding` directly; this is the wizard's own signup path, not the `/__dev/login` shortcut.
- A unique username, email, and project name (include a timestamp) so the run does not collide with another agent's account.

## Steps

1. Open `/onboarding`. Click **Get Started**.
2. On the privacy step, click **Continue** (leave **Share usage data** as found).
3. On **Create your Frontier account**, fill **Username**, **Email**, and **Password**, then click **Create account**. This is a real registration call, not a mock.
4. On **What should we call you?**, the **Display name** field is pre-filled with the username. Replace it with a real name, then click **Continue**.
5. On **How will you use Aquilla?**, click **Just me**.
6. On **Create your first project**, fill **Project Name**, **Source Language**, and **Target language**, then click **Create Project**.
7. On **You're all set!**, click **Start Translating**.

## Expected end state

- Step 3 advances to the display-name step without an error; a failed registration would leave you stuck on the account step.
- Step 7 lands on `/project/<id>/editor` for the project you just named.

## Counts as a failure

- **Create account** does nothing, or an error appears instead of advancing to the display-name step.
- **Create Project** does nothing, or **You're all set!** never appears.
- **Start Translating** does not navigate to `/project/<id>/editor`.

## Notes for the agent

- Every step here is a `main "Account setup"` region with one heading; the fastest way to confirm you moved forward is that the heading text changed, not just that a click succeeded.
- **Source Language** and **Target language** on the project step accept typed language names (`English`, `French`), not just codes, and don't need their option list to open.
- The wizard also offers a **Dev login (skip auth)** button and a **Skip for now** button on the account step. Do not use them: this journey exists to prove the real signup path the smoke spec exercises.
