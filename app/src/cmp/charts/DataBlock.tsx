import type { dataBlockProps } from '../../types/charts';

export default function DataBlock({ header, value, icon }: dataBlockProps) {
    return (
        <div>
            {icon && <div>{icon}</div>}

            <h2>{header}</h2>
            <p>{value}</p>
        </div>
    );
}
