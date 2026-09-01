import type { dataBlockProps } from '../../types/charts';

export default function DataBlock({ header, value, icon }: dataBlockProps) {
    return (
        <div
            style={{
                border: '2px solid black',
                padding: '1rem',
                minWidth: '150px',
                textAlign: 'center',
            }}
        >
            {icon && <div style={{ fontSize: '1.5rem' }}>{icon}</div>}
            <div style={{ fontSize: '0.9rem', color: '#555' }}>{header}</div>
            <div style={{ fontSize: '1.75rem', fontWeight: 'bold' }}>
                {value}
            </div>
        </div>
    );
}
