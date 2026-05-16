import { Outlet, createRootRouteWithContext } from "@tanstack/solid-router";

export interface RouterContext {}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootComponent,
});

function RootComponent() {
  return (
    <div class="h-svh">
      <Outlet />
    </div>
  );
}
