import * as React from "react"
import { CalendarIcon } from "lucide-react"

import { Calendar } from "@/components/ui/calendar"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

/** Parse API deadline "YYYY-MM-DD" as a local calendar date. */
export function deadlineStringToDate(value: string | null | undefined): Date | undefined {
  if (!value) return undefined
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return undefined
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

/** Format a local calendar date as API deadline "YYYY-MM-DD". */
export function dateToDeadlineString(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

function formatDate(date: Date | undefined) {
  if (!date) return ""
  return date.toLocaleDateString("en-US", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  })
}

function isValidDate(date: Date | undefined) {
  if (!date) return false
  return !Number.isNaN(date.getTime())
}

/** Bounds for calendar month/year dropdowns (deadlines may be set years ahead). */
function calendarMonthBounds(now = new Date()) {
  const year = now.getFullYear()
  return {
    startMonth: new Date(year - 1, 0),
    endMonth: new Date(year + 30, 11),
  }
}

interface DatePickerProps {
  value?: Date
  onChange: (date: Date | undefined) => void
  disabled?: boolean
  placeholder?: string
  id?: string
}

export function DatePicker({
  value,
  onChange,
  disabled,
  placeholder = "June 01, 2025",
  id,
}: DatePickerProps) {
  const [open, setOpen] = React.useState(false)
  const [textValue, setTextValue] = React.useState(() => formatDate(value))
  const [month, setMonth] = React.useState<Date | undefined>(value)

  React.useEffect(() => {
    setTextValue(formatDate(value))
    setMonth(value)
  }, [value])

  const pickerId = id ? `${id}-picker` : "date-picker"
  const { startMonth, endMonth } = calendarMonthBounds()

  return (
    <InputGroup>
      <InputGroupInput
        id={id}
        value={textValue}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => {
          const next = e.target.value
          setTextValue(next)
          if (!next.trim()) {
            onChange(undefined)
            return
          }
          const parsed = new Date(next)
          if (isValidDate(parsed)) {
            onChange(parsed)
            setMonth(parsed)
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault()
            setOpen(true)
          }
        }}
      />
      <InputGroupAddon align="inline-end">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            render={
              <InputGroupButton
                id={pickerId}
                variant="ghost"
                size="icon-xs"
                aria-label="Select date"
                disabled={disabled}
              >
                <CalendarIcon />
                <span className="sr-only">Select date</span>
              </InputGroupButton>
            }
          />
          <PopoverContent
            className="w-auto overflow-hidden p-0"
            align="end"
            alignOffset={-8}
            sideOffset={10}
          >
            <Calendar
              mode="single"
              selected={value}
              month={month}
              defaultMonth={value}
              startMonth={startMonth}
              endMonth={endMonth}
              captionLayout="dropdown"
              onMonthChange={setMonth}
              disabled={disabled}
              onSelect={(date) => {
                onChange(date)
                setTextValue(formatDate(date))
                setOpen(false)
              }}
            />
          </PopoverContent>
        </Popover>
      </InputGroupAddon>
    </InputGroup>
  )
}
