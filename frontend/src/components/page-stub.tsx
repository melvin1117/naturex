import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type PageStubProps = {
  title: string;
  description: string;
  /** Tasks in tasks/todo.md that build this page, e.g. ["T21", "T22"]. */
  builtIn: readonly string[];
};

export function PageStub({ title, description, builtIn }: PageStubProps) {
  return (
    <section className="mx-auto w-full max-w-6xl px-4 py-10">
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Coming soon</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          Built in
          {builtIn.map((task) => (
            <Badge key={task} variant="secondary">
              {task}
            </Badge>
          ))}
        </CardContent>
      </Card>
    </section>
  );
}
