import { DbLink } from "./db-link";
import { Card, CardContent } from "./ui/card";

interface ErrorCardProps {
  title: string;
  message?: string;
  backTo?: {
    href: string;
    label: string;
  };
}

export function ErrorCard({
  title,
  message = "Please check your database connection and try again.",
  backTo,
}: ErrorCardProps) {
  return (
    <div className="p-6">
      <Card>
        <CardContent className="py-8 text-center">
          <p className="text-error-600 font-medium">{title}</p>
          <p className="text-gray-500 text-sm mt-1">{message}</p>
          {backTo && (
            <DbLink
              to={backTo.href}
              className="inline-block mt-4 text-primary-600 hover:text-primary-700"
            >
              {backTo.label}
            </DbLink>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
