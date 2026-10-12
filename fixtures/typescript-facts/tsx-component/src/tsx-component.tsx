import React from "react";

export interface ButtonProps {
  label: string;
  onClick?: () => void;
}

export function Button({ label, onClick }: ButtonProps): JSX.Element {
  return <button onClick={() => onClick?.()}>{format(label)}</button>;
}

export const List = ({ items }: { items: string[] }) => (
  <ul>
    {items.map((item) => (
      <li key={item}>{item}</li>
    ))}
  </ul>
);
