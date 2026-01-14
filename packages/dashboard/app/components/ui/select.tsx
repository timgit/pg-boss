import {
  Select as AriaSelect,
  SelectValue,
  Button,
  Popover,
  ListBox,
  ListBoxItem,
  type SelectProps as AriaSelectProps,
  type Key,
} from "react-aria-components";

interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps
  extends Omit<AriaSelectProps<SelectOption>, "children" | "className"> {
  options: SelectOption[];
  placeholder?: string;
  className?: string;
  label?: string;
}

export function Select({
  options,
  placeholder = "Select...",
  className = "",
  label,
  ...props
}: SelectProps) {
  return (
    <AriaSelect {...props} className={`group ${className}`}>
      {label && (
        <label className="block text-sm font-medium text-gray-700 mb-1.5">
          {label}
        </label>
      )}
      <Button className="flex items-center justify-between w-full px-3 py-2 text-sm bg-white border border-gray-300 rounded-lg shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-600 focus:ring-offset-2">
        <SelectValue className="flex-1 text-left text-gray-900 truncate">
          {({ selectedText }) => (
            <span className={selectedText ? "" : "text-gray-500"}>
              {selectedText || placeholder}
            </span>
          )}
        </SelectValue>
        <ChevronIcon className="w-5 h-5 text-gray-400 ml-2" />
      </Button>
      <Popover className="w-[--trigger-width] mt-1 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden z-50">
        <ListBox className="max-h-60 overflow-auto py-1 focus:outline-none">
          {options.map((option) => (
            <ListBoxItem
              key={option.value}
              id={option.value}
              textValue={option.label}
              className="px-3 py-2 text-sm text-gray-900 cursor-pointer hover:bg-gray-100 focus:bg-primary-50 focus:text-primary-900 focus:outline-none selected:bg-primary-50 selected:text-primary-900"
            >
              {option.label}
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </AriaSelect>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="m19.5 8.25-7.5 7.5-7.5-7.5"
      />
    </svg>
  );
}
