import type { dataBlockProps } from '../../types/charts';

export default function DataBlock({ header, value, icon }: dataBlockProps) {
    return (
        <div className="data-block">
            {icon && (
                <div className="data-block-icon" aria-hidden="true">
                    {icon}
                </div>
            )}

            <div className="data-block-content">
                <h2>{header}</h2>
                <p>{value}</p>
            </div>
        </div>
    );
}
