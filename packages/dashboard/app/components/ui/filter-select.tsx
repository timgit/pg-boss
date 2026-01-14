interface FilterOption<T extends string | null> {
  value: T;
  label: string;
}

interface FilterSelectProps<T extends string | null> {
  value: T;
  options: FilterOption<T>[];
  onChange: (value: T) => void;
}

export function FilterSelect<T extends string | null>({
  value,
  options,
  onChange,
}: FilterSelectProps<T>) {
  return (
    <select
      value={value ?? ""}
      onChange={(e) => onChange((e.target.value || null) as T)}
      className="px-3 py-2 text-sm bg-white border border-gray-300 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-primary-600 focus:ring-offset-2"
    >
      {options.map((option) => (
        <option key={option.label} value={option.value ?? ""}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
