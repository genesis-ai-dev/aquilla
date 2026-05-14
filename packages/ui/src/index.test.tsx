// Smoke tests for the @aquilla/ui primitives. These exist mainly to keep
// the primitives renderable in isolation so a regression in one breaks
// before it breaks every auth app's test.

import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import {
  Button,
  Input,
  Label,
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardFooter,
  Alert,
  FormRow,
} from "./index"

describe("Button", () => {
  it("renders as a <button> with type=button by default", () => {
    render(<Button>Click</Button>)
    const btn = screen.getByRole("button", { name: "Click" })
    expect(btn).toBeInTheDocument()
    expect(btn).toHaveAttribute("type", "button")
  })

  it("forwards type=submit when explicitly set", () => {
    render(<Button type="submit">Go</Button>)
    expect(screen.getByRole("button", { name: "Go" })).toHaveAttribute(
      "type",
      "submit",
    )
  })

  it("supports disabled state", () => {
    render(<Button disabled>Off</Button>)
    expect(screen.getByRole("button", { name: "Off" })).toBeDisabled()
  })
})

describe("Input", () => {
  it("renders an input with the right type", () => {
    render(<Input type="email" placeholder="you@example.com" />)
    const input = screen.getByPlaceholderText("you@example.com")
    expect(input).toBeInTheDocument()
    expect(input).toHaveAttribute("type", "email")
  })
})

describe("Label", () => {
  it("associates with input via htmlFor", () => {
    render(
      <>
        <Label htmlFor="email">Email</Label>
        <Input id="email" />
      </>,
    )
    expect(screen.getByLabelText("Email")).toBeInTheDocument()
  })
})

describe("Card", () => {
  it("renders the whole header+content+footer tree", () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Login</CardTitle>
        </CardHeader>
        <CardContent>body</CardContent>
        <CardFooter>foot</CardFooter>
      </Card>,
    )
    expect(screen.getByText("Login")).toBeInTheDocument()
    expect(screen.getByText("body")).toBeInTheDocument()
    expect(screen.getByText("foot")).toBeInTheDocument()
  })
})

describe("Alert", () => {
  it("renders message and exposes tone via data-tone", () => {
    render(<Alert tone="error">Bad creds</Alert>)
    const alert = screen.getByText("Bad creds")
    expect(alert).toBeInTheDocument()
    expect(alert).toHaveAttribute("data-tone", "error")
  })

  it("defaults to info tone", () => {
    render(<Alert>fyi</Alert>)
    expect(screen.getByText("fyi")).toHaveAttribute("data-tone", "info")
  })
})

describe("FormRow", () => {
  it("renders label + hint when no error", () => {
    render(
      <FormRow label="Email" htmlFor="email" hint="we'll never share it">
        <Input id="email" />
      </FormRow>,
    )
    expect(screen.getByText("Email")).toBeInTheDocument()
    expect(screen.getByText("we'll never share it")).toBeInTheDocument()
  })

  it("renders error in place of hint", () => {
    render(
      <FormRow
        label="Email"
        htmlFor="email"
        hint="we'll never share it"
        error="invalid"
      >
        <Input id="email" />
      </FormRow>,
    )
    expect(screen.getByText("invalid")).toBeInTheDocument()
    expect(screen.queryByText("we'll never share it")).not.toBeInTheDocument()
  })
})
