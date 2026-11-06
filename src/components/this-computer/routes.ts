export const THIS_COMPUTER_PATH = "/this-computer"
export const PARATEXT_PATH = "/paratext"

/** Routes that belong to the "This computer" workspace rather than an org. */
export function isThisComputerRoute(pathname: string): boolean {
  return (
    pathname === THIS_COMPUTER_PATH ||
    pathname.startsWith(`${THIS_COMPUTER_PATH}/`) ||
    pathname === PARATEXT_PATH ||
    pathname.startsWith(`${PARATEXT_PATH}/`)
  )
}
